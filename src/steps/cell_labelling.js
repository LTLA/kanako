import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as rutils from "../readers/index.js";
import * as inputs_module from "./inputs.js";
import * as markers_module from "./marker_detection.js";

var downloadFun = async (url) => {
    let resp = await fetch(url);
    if (!resp.ok) {
        throw new Error("failed to fetch content at " + url + "(" + resp.status + ")");
    }
    return await resp.arrayBuffer();
};

const proxy = "https://cors-proxy.aaron-lun.workers.dev";
const hs_base = "https://github.com/clusterfork/singlepp-references/releases/download/hs-latest";
const mm_base = "https://github.com/clusterfork/singlepp-references/releases/download/mm-latest";

// Loaded references are constant, independent of the dataset;
// so we can keep these as globals for re-use across States.
const hs_loaded = {};
const mm_loaded = {};

/**
 * Cell labelling involves assigning cell type labels to clusters using the [**SingleR** algorithm](https://github.com/LTLA/CppSingleR),
 * based on [pre-formatted reference expression profiles](https://github.com/clusterfork/singlepp-references).
 * This wraps `labelCells` and related functions from [**scran.js**](https://github.com/jkanche/scran.js).
 *
 * In theory, we could do this at the single-cell level, but we use clusters instead to expedite the computation and simplify interpretation.
 * If multiple references are requested, we will use each for assignment before attempting to choose the best label for each cluster across references.
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class CellLabellingState {
    #inputs;
    #markers;
    #parameters;
    #cache;

    #hs_built;
    #mm_built;

    constructor(inputs, markers, parameters = null, cache = null) {
        if (!(inputs instanceof inputs_module.InputsState)) {
            throw new Error("'inputs' should be a State object from './inputs.js'");
        }
        this.#inputs = inputs;

        if (!(markers instanceof markers_module.MarkerDetectionState)) {
            throw new Error("'markers' should be a State object from './marker_detection.js'");
        }
        this.#markers = markers;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;

        this.#hs_built = {};
        this.#mm_built = {};
    }

    free() {
        utils.freeCache(this.#cache.buffer);
        for (const [k, v] of Object.entries(this.#hs_built)) {
            v.raw.free();
        }
        for (const [k, v] of Object.entries(this.#mm_built)) {
            v.raw.free();
        }
    }

    /***************************
     ******** Getters **********
     ***************************/

    fetchParameters() {
        // Avoid any pass-by-reference activity.
        let out = { ...this.#parameters };
        for (const key of [ "human_references", "mouse_references" ]) {
            out[key] = out[key].slice();
        }
        return out;
    }

    /***************************
     ******** Compute **********
     ***************************/

    async #build_reference(name, species, rebuild) {
        let base;
        let all_loaded;
        let all_built;
        if (species == "human") {
            base = hs_base;
            all_loaded = hs_loaded;
            all_built = this.#hs_built;
        } else {
            base = mm_base;
            all_loaded = mm_loaded;
            all_built = this.#mm_built;
        }

        if (!(name in all_loaded)) {
            let buffers = await Promise.all([
                downloadFun(proxy + "/" + encodeURIComponent(base + "/" + name + "_genes.csv.gz")),
                downloadFun(proxy + "/" + encodeURIComponent(base + "/" + name + "_labels_fine.csv.gz")),
                downloadFun(proxy + "/" + encodeURIComponent(base + "/" + name + "_label_names_fine.csv.gz")),
                downloadFun(proxy + "/" + encodeURIComponent(base + "/" + name + "_markers_fine.gmt.gz")),
                downloadFun(proxy + "/" + encodeURIComponent(base + "/" + name + "_matrix.csv.gz"))
            ]);

            let loaded;
            try {
                loaded = scran.loadLabelledReferenceFromBuffers(
                    new Uint8Array(buffers[4]), // rank matrix
                    new Uint8Array(buffers[3]), // markers
                    new Uint8Array(buffers[1])) // label per sample

                let gene_lines = rutils.readLines(new Uint8Array(buffers[0]), { compression: "gz" }); // gene names
                let ensembl = [];
                let symbol = [];
                gene_lines.forEach(x => {
                    let fields = x.split(",");
                    ensembl.push(fields[0]);
                    symbol.push(fields[1]);
                });

                let labels = rutils.readLines(new Uint8Array(buffers[2]), { compression: "gz" }); // full label names
                all_loaded[name] = { 
                    "raw": loaded, 
                    "genes": {
                        "ensembl": ensembl,
                        "symbol": symbol
                    },
                    "labels": labels
                };

            } catch (e) {
                utils.freeCache(loaded);
                throw e;
            }
        }

        if (!(name in all_built) || rebuild) {
            let built;
            try {
                if (name in all_built) {
                    utils.freeCache(all_built[name].raw);
                }

                let current = all_loaded[name];
                let loaded = current.raw;

                let chosen_ids;
                if (this.#cache.feature_details.type === "ensembl") {
                    chosen_ids = current.genes.ensembl;
                } else {
                    chosen_ids = current.genes.symbol;
                }

                let built = scran.buildLabelledReference(this.#cache.features, loaded, chosen_ids); 
                all_built[name] = {
                    "features": chosen_ids,
                    "raw": built
                };

            } catch (e) {
                utils.freeCache(built);
                throw e;
            }
        }

        return {
            "loaded": all_loaded[name],
            "built": all_built[name]
        };
    }

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     * Each argument is taken from the property of the same name in the `cell_labelling` property of the `parameters` of {@linkcode runAnalysis}.
     *
     * @param {Array} mouse_references - Array of strings specifying the names of the reference datasets for mouse datasets, e.g., `"ImmGen"`.
     * @param {Array} human_references - Array of strings specifying the names of the reference datasets for human datasets, e.g., `"BlueprintEncode"`.
     *
     * @return The object is updated with the new results.
     */
    compute(human_references, mouse_references) {
        if (!this.#inputs.changed && 
            !this.#markers.changed &&
            compare_arrays(human_references, this.#parameters.human_references) &&
            compare_arrays(mouse_references, this.#parameters.mouse_references)) 
        {
            this.changed = false;
            return new Promise(resolve => resolve(null));
        }

        if (this.#inputs.changed || !("features" in this.#cache)) {
            let feat_out = choose_features(this.#inputs);
            this.#cache.features = feat_out.features;
            this.#cache.feature_details = feat_out.details;
        }
        let species = this.#cache.feature_details.species;

        // Take ownership to avoid pass-by-reference shenanigans.
        human_references = human_references.slice();
        mouse_references = mouse_references.slice();

        // Fetching all of the references. This is effectively a no-op
        // if the inputs have not changed, so we do it to fill up 'valid'.
        let valid = {};
        if (species == "human") {
            for (const ref of human_references) {
                valid[ref] = this.#build_reference(ref, "human", this.#inputs.changed);
            }
        } else if (species == "mouse") {
            for (const ref of mouse_references) {
                valid[ref] = this.#build_reference(ref, "mouse", this.#inputs.changed);
            }
        }

        // Creating a column-major array of mean vectors for each cluster.
        let cluster_means = this.#cache.buffer;
        let ngenes = this.#cache.features.length;
        let ngroups = this.#markers.numberOfGroups(); 

        if (this.#markers.changed || typeof cluster_means === "undefined") {
            cluster_means = utils.allocateCachedArray(ngroups * ngenes, "Float64Array", this.#cache);

            for (var g = 0; g < ngroups; g++) {
                let means = this.#markers.fetchGroupMeans(g, "RNA", { copy: false }); // Warning: direct view in wasm space - be careful.
                let cluster_array = cluster_means.array();
                cluster_array.set(means, g * ngenes);
            }
        }

        let promises = [];

        // Running classifications on the cluster means. Note that compute() itself
        // cannot be async, as we need to make sure 'changed' is set and available for
        // downstream steps; hence the explicit then().
        this.#cache.results = {};
        for (const [key, val] of Object.entries(valid)) {
            let p = val.then(ref => {
                let output = scran.labelCells(cluster_means, ref.built.raw, { numberOfFeatures: ngenes, numberOfCells: ngroups });
                let labels = [];
                for (const o of output) {
                    labels.push(ref.loaded.labels[o]);
                }
                return labels;
            });
            this.#cache.results[key] = p;
            promises.push(p);
        }

        // Performing additional integration, if necessary. We don't really 
        // need this if there's only one reference.
        let used_refs = Object.keys(valid);
        if (used_refs.length > 1) {
            if (this.#inputs.changed || !compare_arrays(used_refs, this.#cache.used) || !("integrated" in this.#cache)) {
                let used_vals = Object.values(valid);

                this.#cache.integrated = Promise.all(used_vals)
                    .then(arr => {
                        let loaded = arr.map(x => x.loaded.raw);
                        let feats = arr.map(x => x.built.features);
                        let built = arr.map(x => x.built.raw);
                        return scran.integrateLabelledReferences(this.#cache.features, loaded, feats, built);
                    }
                );
            }

            let p = this.#cache.integrated
                .then(async (integrated) => {
                    let results = [];
                    for (const key of used_refs) {
                        results.push(await this.#cache.results[key]);
                    }

                    let out = scran.integrateCellLabels(cluster_means, results, integrated, { numberOfFeatures: ngenes, numberOfCells: ngroups });
                    let as_names = [];
                    out.forEach(i => {
                        as_names.push(used_refs[i]);
                    });
                    return as_names;
                }
            );
            this.#cache.integrated_results = p;
            promises.push(p);
        } else {
            delete this.#cache.integrated_results;
        }

        this.#cache.used = used_refs;
        this.#parameters.human_references = human_references;
        this.#parameters.mouse_references = mouse_references;
        this.changed = true;

        return Promise.all(promises).then(x => null);
    }

    /***************************
     ******** Results **********
     ***************************/

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return A promise that resolves to an object containing:
     *
     * - `per_reference`: an object where keys are the reference names and the values are arrays of strings.
     *   Each array is of length equal to the number of clusters and contains the cell type classification for each cluster.
     * - `integrated`: an array of length equal to the number of clusters.
     *   Each element is a string specifying the name of the reference with the best label for each cluster.
     */
    async summary() {
        // No real need to clone these, they're string arrays
        // so they can't be transferred anyway.
        let perref = {};
        for (const [key, val] of Object.entries(this.#cache.results)) {
            perref[key] = await val;
        }

        let output = { "per_reference": perref };
        if ("integrated_results" in this.#cache) {
            output.integrated = await this.#cache.integrated_results;
        }

        return output;
    }

    /*************************
     ******** Saving *********
     *************************/

    async serialize(handle) {
        let ghandle = handle.createGroup("cell_labelling");
        
        {
            let phandle = ghandle.createGroup("parameters");
            phandle.writeDataSet("mouse_references", "String", null, this.#parameters.mouse_references);
            phandle.writeDataSet("human_references", "String", null, this.#parameters.human_references);
        }

        {
            let rhandle = ghandle.createGroup("results");
            let res = await this.summary();

            let perhandle = rhandle.createGroup("per_reference");
            for (const [key, val] of Object.entries(res.per_reference)) {
                perhandle.writeDataSet(key, "String", null, val);
            }

            if ("integrated" in res) {
                rhandle.writeDataSet("integrated", "String", null, res.integrated);
            }
        }

        return;
    }
}

/**************************
 ******* Internals ********
 **************************/

// Try to figure out the best feature identifiers to use,
// based on the highest confidence annotation.
function choose_features(inputs) {
    let genes = inputs.fetchGenes();
    let types = inputs.fetchGeneTypes();

    let best_feature = null;
    let best = null;
    for (const [key, val] of Object.entries(types)) {
        if (best === null) {
            best_feature = key;
            best = val;
        } else if (val.confidence > best.confidence) {
            best_feature = key;
            best = val;
        }
    }

    return {
        features: genes[best_feature],
        details: best 
    };
}

function compare_arrays(x, y) {
    if (typeof x === "undefined" || typeof y === "undefined") {
        return false;
    }
    if (x.length != y.length) {
        return false;
    }
    for (var i = 0; i < x.length; i++) {
        if (x[i] != y[i]) {
            return false;
        }
    }
    return true;
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, inputs, markers) {
    let parameters =  {
        mouse_references: [],
        human_references: []
    };
    let cache = { results: {} };

    // Protect against old analysis states that don't have cell_labelling.
    if ("cell_labelling" in handle.children) {
        let ghandle = handle.open("cell_labelling");
        
        {
            let phandle = ghandle.open("parameters");
            parameters.mouse_references = phandle.open("mouse_references", { load: true }).values;
            parameters.human_references = phandle.open("human_references", { load: true }).values;
        }

        {
            let rhandle = ghandle.open("results");
            let perhandle = rhandle.open("per_reference");
            for (const key of Object.keys(perhandle.children)) {
                cache.results[key] = perhandle.open(key, { load: true }).values;
            }
            if ("integrated" in rhandle.children) {
                cache.integrated_results = rhandle.open("integrated", { load: true }).values;
            }
        }
    }

    return new CellLabellingState(inputs, markers, parameters, cache);
}

/**************************
 ******** Setters *********
 **************************/

/**
 * Specify a function to download references for the cell labelling step.
 *
 * @param {function} fun - Function that accepts a single string containing a URL,
 * and returns an ArrayBuffer of that URL's contents.
 *
 * @return `fun` is set as the global downloader for this step. 
 * The _previous_ value of the downloader is returned.
 */
export function setCellLabellingDownload(fun) {
    let previous = downloadFun;
    downloadFun = fun;
    return previous;
}
