import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as filter_module from "./cell_filtering.js";
import * as norm_module from "./crispr_normalization.js";

export const step_name = "crispr_pca";

/**
 * This step performs a principal components analysis (PCA) to compact and denoise CRISPR abundance data.
 * The resulting PCs can be used as input to various per-cell analyses like clustering and dimensionality reduction.
 * It wraps the [`runPCA`](https://kanaverse.github.io/scran.js/global.html#runPCA) function
 * from [**scran.js**](https://github.com/kanaverse/scran.js).
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class CrisprPcaState {
    #filter;
    #norm;
    #cache;
    #parameters;

    constructor(filter, norm, parameters = null, cache = null) {
        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filter' should be a CellFilteringState object");
        }
        this.#filter = filter;

        if (!(norm instanceof norm_module.CrisprNormalizationState)) {
            throw new Error("'norm' should be a CrisprNormalizationState object");
        }
        this.#norm = norm;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.pcs);
    }

    /***************************
     ******** Getters **********
     ***************************/

    valid() {
        return this.#norm.valid();
    }

    /**
     * @return {external:RunPCAResults} Results of the PCA on the normalized CRISPR abundance matrix,
     * available after running {@linkcode CrisprPcaState#compute compute}.
     */
    fetchPCs() {
        return this.#cache.pcs;
    }

    /**
     * @return {object} Object containing the parameters.
     */
    fetchParameters() {
        return { ...this.#parameters }; // avoid pass-by-reference links.
    }

    /***************************
     ******** Compute **********
     ***************************/

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     *
     * @param {object} parameters - Parameter object, equivalent to the `crispr_pca` property of the `parameters` of {@linkcode runAnalysis}.
     * @param {number} parameters.num_pcs - Number of PCs to return.
     * @param {string} parameters.block_method - Blocking method to use when dealing with multiple samples.
     * This can be `"none"`, `"regress"` or `"weight"`, see comments in {@linkplain RnaPcaState}.
     *
     * @return The object is updated with the new results.
     */
    compute(parameters) {
        let { num_pcs, block_method } = parameters;
        this.changed = false;

        if (this.#norm.changed || num_pcs !== this.#parameters.num_pcs || block_method !== this.#parameters.block_method) { 
            if (this.valid()) {
                let block = this.#filter.fetchFilteredBlock();
                var mat = this.#norm.fetchNormalizedMatrix();
                utils.freeCache(this.#cache.pcs);
                this.#cache.pcs = scran.runPCA(mat, { numberOfPCs: num_pcs, block: block, blockMethod: block_method });

                this.changed = true;
            }

            this.#parameters.num_pcs = num_pcs;
            this.#parameters.block_method = block_method;
        }

        return;
    }

    static defaults() {
        return {
            num_pcs: 20,
            block_method: "none"
        };
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, filter, norm) {
    let cache = {};
    let parameters = CrisprPcaState.defaults();
    let output;

    if (step_name in handle.children) {
        let ghandle = handle.open(step_name);

        let phandle = ghandle.open("parameters"); 
        parameters.num_pcs = phandle.open("num_pcs", { load: true }).values[0];
        parameters.block_method = phandle.open("block_method", { load: true }).values[0];

        try {
            let rhandle = ghandle.open("results");

            if ("var_exp" in rhandle.children) {
                let pcs_handle = rhandle.open("pcs", { load: true });
                let pcs = pcs_handle.values;
                let var_exp = rhandle.open("var_exp", { load: true }).values;

                cache.pcs = scran.emptyRunPCAResults(pcs_handle.shape[0], pcs_handle.shape[1]);
                cache.pcs.principalComponents({ fillable: true }).set(pcs);
                cache.pcs.varianceExplained({ fillable: true }).set(var_exp);
                cache.pcs.setTotalVariance(1); // because the file only stores proportions.
            }

            output = new CrisprPcaState(filter, norm, parameters, cache);
        } catch (e) {
            utils.freeCache(cache.pcs);
            utils.freeCache(output);
            throw e;
        }
    } else {
        output = new CrisprPcaState(filter, norm, parameters, cache);
    }

    return output;
}