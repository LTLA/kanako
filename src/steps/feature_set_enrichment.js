import * as scran from "scran.js";
import * as bioc from "bioconductor";
import * as gesel from "gesel";

import * as utils from "./utils/general.js";
import * as mutils from "./utils/markers.js";
import * as rutils from "../readers/index.js";
import * as inputs_module from "./inputs.js";
import * as filter_module from "./cell_filtering.js";
import * as norm_module from "./rna_normalization.js";
import * as markers_module from "./marker_detection.js";

export const step_name = "feature_set_enrichment";

/****************************
 ******** Internals *********
 ****************************/

class FeatureSetManager {
    #cache;

    constructor() {
        this.#cache = {};
    }

    free() {
        utils.freeCache(this.#cache.set_buffer);
        this.#cache = {};
    }

    static flush() {
        // TODO: call a gesel flush() function.
        return;
    }

    static setDownload(fun) {
        console.warn("'FeatureSetState.setDownload' is a no-op, uses 'gesel.setReferenceDownload' and 'gesel.setGeneDownload' instead");
        return;
    }

    async prepare(feats, species, gene_id_column, gene_id_type) {
        let data_id_col;
        if (gene_id_column == null) {
            data_id_col = feats.rowNames();
            if (data_id_col == null) {
                // If there truly is no annotation, then we avoid throwing,
                // and we just make the rest of this function a no-op.
                species = []; 
            }
        } else {
            data_id_col = feats.column(gene_id_column);
        }

        let search_options = { types: [ gene_id_type.toLowerCase() ] };

        // To avoid repeated rellocations on array resizing, we create
        // preallocated arrays within each species and then do a single COMBINE
        // across species. We provide an initial element so that COMBINE works
        // correctly when there are no species.
        let collection_offset = 0;
        let all_collection_names = [[]];
        let all_collection_descriptions = [[]];
        let all_collection_species = [[]];

        let set_offset = 0;
        let all_set_names = [[]];
        let all_set_descriptions = [[]];
        let all_set_indices = [[]];
        let all_set_sizes = [new Int32Array];
        let all_set_collections = [new Int32Array];

        let mapped_genes = new Set;
        let remapped = new Array(feats.numberOfRows());
        for (var r = 0; r < remapped.length; r++) {
            remapped[r] = [];
        }

        for (const spec of species) {
            // Mapping our features to those in the gesel database. 
            let gene_mapping = await gesel.searchGenes(spec, data_id_col, search_options);
            for (var i = 0; i < gene_mapping.length; i++) {
                if (gene_mapping[i].length > 0) {
                    mapped_genes.add(i);
                }
            }

            // Formatting the details for each set. This includes reindexing
            // the gesel gene IDs to refer to row indices of 'feats'.
            let all_sets2genes = await gesel.fetchGenesForAllSets(spec);
            let set_indices = gesel.reindexGenesForAllSets(gene_mapping, all_sets2genes);

            let all_sets = await gesel.fetchAllSets(spec);
            let nsets = all_sets.length;
            let set_names = new Array(nsets);
            let set_descriptions = new Array(nsets);
            let set_sizes = new Int32Array(nsets);
            let set_collections = new Int32Array(nsets);

            for (var i = 0; i < nsets; i++) {
                let current = all_sets[i];
                set_names[i] = current.name;
                set_descriptions[i] = current.description;
                set_collections[i] = current.collection + collection_offset; // offset effectively "namespaces" collections from different species.
                set_sizes[i] = set_indices[i].length;
            }

            all_set_names.push(set_names);
            all_set_descriptions.push(set_descriptions);
            all_set_indices.push(set_indices);
            all_set_sizes.push(set_sizes);
            all_set_collections.push(set_collections);

            // Updating the gene->set mapping for input features.
            let all_genes2sets = await gesel.fetchSetsForAllGenes(spec);
            let current_remapped = gesel.reindexSetsForAllGenes(gene_mapping, all_genes2sets);
            for (var i = 0; i < gene_mapping.length; i++) {
                let current = current_remapped[i];
                for (var j = 0; j < current.length; j++) {
                    current[j] += set_offset; // offset effectively "namespaces" sets from different species.
                }
                remapped[i].push(current);
            }

            // Sticking the collection details somewhere.
            let all_collections = await gesel.fetchAllCollections(spec);
            let ncollections = all_collections.length;
            let collection_names = new Array(ncollections);
            let collection_descriptions = new Array(ncollections);
            let collection_species = new Array(ncollections);

            for (var i = 0; i < ncollections; i++) {
                collection_names[i] = all_collections[i].name;
                collection_descriptions[i] = all_collections[i].description;
                collection_species[i] = spec;
            }

            all_collection_names.push(collection_names);
            all_collection_descriptions.push(collection_descriptions);
            all_collection_species.push(collection_species);

            set_offset += nsets;
            collection_offset += ncollections;
        }

        this.#cache.universe = (new Int32Array(mapped_genes)).sort();

        this.#cache.sets = {
            names: bioc.COMBINE(all_set_names),
            descriptions: bioc.COMBINE(all_set_descriptions),
            sets: bioc.COMBINE(all_set_indices),
            sizes: bioc.COMBINE(all_set_sizes),
            collections: bioc.COMBINE(all_set_collections)
        };

        this.#cache.collections = {
            names: bioc.COMBINE(all_collection_names),
            descriptions: bioc.COMBINE(all_collection_descriptions),
            species: bioc.COMBINE(all_collection_species)
        };

        if (species.length > 0) {
            for (var r = 0; r < remapped.length; r++) {
                remapped[r] = bioc.COMBINE(remapped[r]);
            }
        } else {
            for (var r = 0; r < remapped.length; r++) {
                remapped[r] = new Uint32Array;
            }
        }
        this.#cache.mapping_to_sets = remapped;

        return;
    }

    fetchCollectionDetails() {
        return this.#cache.collections;
    }

    fetchSetDetails() {
        return { 
            names: this.#cache.sets.names,
            descriptions: this.#cache.sets.descriptions,
            sizes: this.#cache.sets.sizes,
            collections: this.#cache.sets.collections
        };
    }

    fetchUniverseSize() {
        return this.#cache.universe.length;
    }

    computeEnrichment(group, effect_size, summary, markers, top_markers) {
        if (effect_size == "delta_detected") {
            effect_size = "deltaDetected";
        }

        // Avoid picking down-regulated genes in the marker set.
        let min_threshold = effect_size == "auc" ? 0.5 : 0;

        // Larger is better except for 'min_rank'.
        let use_largest = effect_size !== "min_rank"; 
        let sumidx = mutils.summaries2int[summary];

        let stats = markers[effect_size](group, { summary: sumidx, copy: false });
        let curstats = bioc.SLICE(stats, this.#cache.universe);
        let threshold = scran.computeTopThreshold(curstats, top_markers, { largest: use_largest });

        let in_set = [];
        let add = i => {
            let gene = this.#cache.universe[i];
            in_set.push(this.#cache.mapping_to_sets[gene]);
        };

        if (use_largest) {
            if (threshold < min_threshold) {
                threshold = min_threshold;
            }
            curstats.forEach((x, i) => {
                if (x >= threshold) {
                    add(i);
                }
            });
        } else {
            curstats.forEach((x, i) => {
                if (x <= threshold) {
                    add(i);
                }
            });
        }

        let overlaps = gesel.countSetOverlaps(in_set);
        let num_top = in_set.length;
        for (const x of overlaps) {
            x.pvalue = gesel.testEnrichment(x.count, num_top, this.#cache.sets.sizes[x.id], this.#cache.universe.length);
        }

        // Sorting by p-value.
        overlaps.sort((a, b) => a.pvalue - b.pvalue);
        let set_ids = new Int32Array(overlaps.length);
        let counts = new Int32Array(overlaps.length);
        let pvalues = new Float64Array(overlaps.length);
        let counter = 0;
        for (const x of overlaps) {
            set_ids[counter] = x.id;
            counts[counter] = x.count;
            pvalues[counter] = x.pvalue;
            counter++;
        }

        return {
            set_ids: set_ids,
            counts: counts, 
            pvalues: pvalues, 
            num_markers: num_top
        };
    }

    fetchFeatureSetIndices(set_id) {
        return this.#cache.sets.sets[set_id];
    }

    computePerCellScores(set_id, normalized, block) {
        let indices = this.fetchFeatureSetIndices(set_id);
        // console.log(bioc.SLICE(this.#inputs.fetchFeatureAnnotations().RNA.column("id"), indices));

        let features = utils.allocateCachedArray(normalized.numberOfRows(), "Uint8Array", this.#cache, "set_buffer");
        features.fill(0);
        let farr = features.array();
        indices.forEach(x => { farr[x] = 1; }); 

        return scran.scoreFeatureSet(normalized, features, { block: block });
    }
}

// More internal functions, mostly related to wrangling with parameters.

function _configureFeatureParameters(guesses) {
    let best_key = null;
    let best = { type: "symbol", species: "human", confidence: 0 };

    if ("row_names" in guesses) {
        let val = guesses.row_names;
        if (val.confidence > best.confidence) {
            best = val;
        }
    }

    for (const [key, val] of Object.entries(guesses.columns)) {
        if (val.confidence > best.confidence) {
            best = val;
            best_key = key;
        }
    }

    return {
        gene_id_column: best_key,
        gene_id_type: best.type.toUpperCase(),
        species: [best.species]
    };
}

async function _buildCollections(old_parameters, manager, automatic, species, gene_id_column, gene_id_type, annofun, guessfun) {
    if (
        automatic !== old_parameters.automatic ||
        (
            !automatic && 
            (
                old_parameters.gene_id_column !== gene_id_column || 
                old_parameters.gene_id_type !== gene_id_type ||
                utils.changedParameters(old_parameters.species, species)
            )
        )
    ) {
        let gene_id_column2 = gene_id_column;
        let gene_id_type2 = gene_id_type;
        let species2 = species;

        if (automatic) {
            let auto = _configureFeatureParameters(guessfun());
            gene_id_column2 = auto.gene_id_column;
            gene_id_type2 = auto.gene_id_type;
            species2 = auto.species;
        }

        await manager.prepare(annofun(), species2, gene_id_column2, gene_id_type2);
        return true;
    }

    return false;
}

function _transplantParameters(parameters, automatic, species, gene_id_column, gene_id_type, top_markers) {
    parameters.automatic = automatic;
    parameters.species = bioc.CLONE(species); // make a copy to avoid pass-by-ref behavior.
    parameters.gene_id_column = gene_id_column;
    parameters.gene_id_type = gene_id_type;
    parameters.top_markers = top_markers;
}

function _fetchParameters(parameters) {
    // Avoid pass-by-reference behavior.
    let out = { ...parameters };
    out.species = bioc.CLONE(out.species);
    return out;
}

/************************
 ******** State *********
 ************************/

/**
 * This step tests for enrichment of particular feature sets in the set of top marker genes,
 * based on marker rankings from {@linkplain MarkerDetectionState}.
 * It wraps the [`testFeatureSetEnrichment`](https://kanaverse.github.io/scran.js/global.html#testFeatureSetEnrichment) 
 * and [`scoreFeatureSet`](https://kanaverse.github.io/scran.js/global.html#scoreFeatureSet) functions
 * from [**scran.js**](https://github.com/kanaverse/scran.js).
 * 
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class FeatureSetEnrichmentState {
    #inputs;
    #filter;
    #normalized;

    #parameters;
    #manager;

    constructor(inputs, filter, normalized, markers, parameters = null, cache = null) {
        if (!(inputs instanceof inputs_module.InputsState)) {
            throw new Error("'inputs' should be a State object from './inputs.js'");
        }
        this.#inputs = inputs;

        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filter' should be a CellFilteringState object");
        }
        this.#filter = filter;

        if (!(normalized instanceof norm_module.RnaNormalizationState)) {
            throw new Error("'normalized' should be a RnaNormalizationState object from './rna_normalization.js'");
        }
        this.#normalized = normalized;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#manager = new FeatureSetManager;
        this.changed = false;
    }

    /**
     * Frees all resources associated with this instance.
     */
    free() {
        this.#manager.free();
        return; 
    }

    valid() {
        let mat = this.#inputs.fetchCountMatrix();
        return mat.has("RNA");
    }

    /**
     * Obtain the details about the feature set collections in the reference database.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @return {object} Object with the following properties:
     *
     * - `names`: Array of strings of length equal to the number of feature set collections, containing the names of the collections.
     * - `descriptions`: Array of strings of length equal to `names`, containing the descriptions for all collections.
     * - `species`: Array of strings of length equal to `names`, containing the taxonomy IDs for all collections.
     */
    fetchCollectionDetails() {
        return this.#manager.fetchCollectionDetails();
    }

    /**
     * Obtain the details about the feature sets in the reference database.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @return {object} Object with the following properties:
     *
     * - `names`: Array of strings of length equal to the number of feature sets across all collections, containing the names of those sets.
     * - `descriptions`: Array of strings of length equal to `names`, containing the set descriptions.
     * - `sizes`: Int32Array of length equal to `names`, containing the set sizes.
     *   Each set's size is defined as the number of features in the dataset that are successfully mapped to a member of the set.
     * - `collections`: Int32Array of length equal to `names`, specifying the collection to which the set belongs.
     *   This is interpreted as the index of the arrays in {@linkcode fetchCollectionDetails}.
     */
    fetchSetDetails() {
        return this.#manager.fetchSetDetails();
    }

    /**
     * Obtain the size of the universe of features that were successfully mapped to features in the reference database.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @return {number} Number of features from the input dataset that were successfully mapped to at least one gene in the reference database.
     */
    fetchUniverseSize() {
        return this.#manager.fetchUniverseSize();
    }

    /**
     * Compute enrichment of top markers in each feature set.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @param {external:ScoreMarkersResults} markers - Arbitrary marker detection results for an RNA modality, with the same order and identity of genes as from the upstream {@linkplain InputsState}.
     * This is most typically the output from {@linkcode MarkerDetectionState#fetchResults MarkerDetectionState.fetchResults} or equivalents from {@linkplain CustomSelectionsState}.
     * @param {number} group - Index of the group of interest inside `markers`.
     * @param {string} effect_size - Effect size to use for ranking.
     * This should be one of `"cohen"`, `"auc"`, `"lfc"` or `"delta_detected"`.
     * @param {string} summary - Summary statistic to use for ranking.
     * This should be one of `"min"`, `"mean"` or `"min_rank"`.
     *
     * @return {object} Object containing the following properties:
     *
     * - `set_ids`: Int32Array of length equal to the number of sets, containing the set IDs.
     *   Each entry is an index into the arrays returned by {@linkcode FeatureSetEnrichmentState#fetchSetDetails fetchSetDetails}.
     * - `counts`: Int32Array of length equal to `set_ids`, containing the number of markers present in each set.
     * - `pvalues`: Float64Array of length equal to `counts`, containing the enrichment p-values for each set.
     * - `num_markers`: number of markers selected for testing.
     */
    computeEnrichment(markers, group, effect_size, summary) {
        return this.#manager.computeEnrichment(group, effect_size, summary, markers, this.#parameters.top_markers);
    }

    /**
     * Extract row indices of the members of a desired feature set of interest.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @param {number} set_id - Feature set ID, defined as an index into the arrays returned by {@linkcode FeatureSetEnrichmentState#fetchSetDetails fetchSetDetails}.
     *
     * @return {Int32Array} Array containing the row indices of the RNA count matrix corresponding to the genes in the specified set.
     */
    fetchFeatureSetIndices(set_id) {
        return this.#manager.fetchFeatureSetIndices(set_id);
    }

    /**
     * Compute per-cell scores for the activity of a feature set.
     * It is assumed that {@linkcode runAnalysis} was already run on this FeatureSetEnrichmentState instance before calling this method.
     *
     * @param {number} set_id - Feature set ID, defined as an index into the arrays returned by {@linkcode FeatureSetEnrichmentState#fetchSetDetails fetchSetDetails}.
     *
     * @return {Object} Object containing:
     *
     * - `indices`: Int32Array containing the row indices of the genes in the set, relative to the RNA count matrix.
     * - `weights`: Float64Array containing the weights of each gene in the set.
     * - `scores`: Float64Array containing the feature set score for each cell.
     */
    computePerCellScores(set_id) {
        return this.#manager.computePerCellScores(set_id, this.#normalized.fetchNormalizedMatrix(), this.#filter.fetchFilteredBlock());
    }

    // Soft-deprecated.
    fetchPerCellScores(collection, set_index) {
        return this.computePerCellScores(collection, set_index);
    }

    /**
     * @return {object} Object containing the parameters.
     */
    fetchParameters() {
        return _fetchParameters(this.#parameters);
    }

    /****************************
     ******** Defaults **********
     ****************************/

    /**
     * @return {object} Default parameters that may be modified and fed into {@linkcode FeatureSetEnrichmentState#compute compute}.
     */
    static defaults() {
        return {
            skip: false,
            automatic: true,
            species: [],
            gene_id_column: null, 
            gene_id_type: "ENSEMBL", 
            top_markers: 100
        };
    }

    /***************************
     ******** Remotes **********
     ***************************/

    static flush() {
        return;
    }

    static setDownload(fun) {
        return FeatureSetManager.setDownload(fun);
    }

    /***************************
     ******** Compute **********
     ***************************/

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     *
     * @param {object} parameters - Parameter object, equivalent to the `feature_set_enrichment` property of the `parameters` of {@linkcode runAnalysis}.
     * @param {boolean} parameters.skip - Whether to skip the preparation of feature set collections.
     * If `true`, none of the other methods (e.g., {@linkcode computeEnrichment}, {@linkcode computePerCellScores}) should be called.
     * @param {boolean} parameters.automatic - Automatically choose feature-based parameters based on the feature annotation for the RNA modality.
     * If `true`, the column of the annotation that best matches human/mouse Ensembl/symbols is identified and used to set `species`, `gene_id_column`, `gene_id_type`.
     * @param {Array} parameters.species - Array of strings specifying zero, one or more species involved in this dataset.
     * Each entry should be a taxonomy ID (e.g. `"9606"`, `"10090"`) as specified in {@linkcode FeatureSetEnrichmentState#availableCollections availableCollections}.
     * This is used internally to filter `collections` to the entries relevant to these species. 
     * Ignored if `automatic = true`.
     * @param {?(string|number)} parameters.gene_id_column - Name or index of the column of the RNA entry of {@linkcode InputsState#fetchFeatureAnnotations InputsState.fetchFeatureAnnotations} containing the identity of each gene. 
     * If `null`, identifiers are taken from the row names.
     * Ignored if `automatic = true`.
     * @param {string} parameters.gene_id_type - Type of feature identifier in `gene_id_column`.
     * This should be one of `"ENSEMBL"`, `"SYMBOL"` or `"ENTREZ"`
     * Ignored if `automatic = true`.
     * @param {number} parameters.top_markers - Number of top markers to use when testing for enrichment.
     *
     * @return The state is updated with new results.
     */
    async compute(parameters) {
        this.changed = false;
        if (this.#inputs.changed) {
            this.changed = true;
        }

        let { skip, automatic, species, gene_id_column, gene_id_type, top_markers } = parameters;
        if (skip !== this.#parameters.skip) {
            this.changed = true;
        }

        if (this.valid() && !skip) {
            if (this.changed) { // Force an update.
                this.#parameters = {};
            }

            let modified = await _buildCollections(
                this.#parameters, 
                this.#manager,
                automatic, 
                species, 
                gene_id_column, 
                gene_id_type, 
                () => this.#inputs.fetchFeatureAnnotations()["RNA"],
                () => this.#inputs.guessRnaFeatureTypes()
            );
            if (modified) {
                this.changed = true;
            }

            if (top_markers !== this.#parameters.top_markers) {
                this.changed = true;
            }
        }

        _transplantParameters(this.#parameters, automatic, species, gene_id_column, gene_id_type, top_markers);
        this.#parameters.skip = skip;
        return;
    }
}

/*****************************
 ******** Standalone *********
 *****************************/

/**
 * Standalone version of {@linkplain FeatureSetEnrichmentState} that provides the same functionality outside of {@linkcode runAnalysis}.
 * Users can supply their own annotation and marker results to compute the enrichment statistics for each group.
 * Users are also responsible for ensuring that the lifetime of the supplied objects exceeds that of the constructed instance,
 * i.e., the Wasm-related `free()` methods of the inputs are not called while the FeatureSetEnrichmentInstance is still in operation.
 *
 * Users should await on the return value of the {@linkcode FeatureSetEnrichmentStandalone#ready ready} method after construction.
 * Once resolved, other methods in this class may be used.
 */
export class FeatureSetEnrichmentStandalone {
    #annotations;
    #guesses;

    #normalized;
    #block;
    #backmap;

    #parameters;
    #manager;

    /**
     * @param {external:DataFrame} annotations - A {@linkplain external:DataFrame DataFrame} of per-gene annotations, where each row corresponds to a gene.
     * @param {object} [options={}] - Optional parameters.
     * @param {?(external:ScranMatrix)} [options.normalized=null] - A {@linkcode external:ScranMatrix ScranMatrix} of log-normalized expression values,
     * to be used in {@linkcode FeatureSetEnrichmentStandalone#computePerCellScores FeatureSetEnrichmentStandalone.computePerCellScores}.
     * Each row corresponds to a gene in the same order as `annotations`. 
     * @param {?(Array|TypedArray)} [options.block=null] - Array of length equal to the number of columns in `normalized`, containing the block assignments for each column. 
     * If `null`, all columns are assigned to the same block.
     */
    constructor(annotations, { normalized = null, block = null } = {}) {
        this.#annotations = annotations;
        this.#guesses = null;

        this.#normalized = null;
        this.#block = null;
        this.#backmap = null;

        if (normalized !== null) {
            if (normalized.numberOfRows() !== this.#annotations.numberOfRows()) {
                throw new Error("number of rows of 'annotations' and 'normalized' should be identical");
            }

            if (block !== null) {
                if (normalized.numberOfColumns() !== block.length) {
                    throw new Error("number of columns of 'normalized' should equal the length of 'block'");
                }

                let dump = utils.subsetInvalidFactors([ block ]);
                if (dump.retain !== null) {
                    this.#normalized = scran.subsetColumns(normalized, dump.retain);
                    this.#backmap = dump.retain;
                } else {
                    this.#normalized = normalized.clone();
                }

                this.#block = dump.arrays[0].ids;
            } else {
                this.#normalized = normalized.clone();
            }
        }

        this.#parameters = FeatureSetEnrichmentState.defaults();
        this.#manager = null;
    }

    #guessFeatureTypes() {
        if (this.#guesses == null) {
            this.#guesses = utils.guessFeatureTypes(this.#annotations);
        }
        return this.#guesses;
    }

    // Testing functions to check that the sanitization worked correctly.
    _peekMatrices() {
        return this.#normalized;
    }

    _peekBlock() {
        return this.#block;
    }

    /**
     * Frees all resources associated with this instance.
     */
    free() {
        scran.free(this.#block);
        scran.free(this.#normalized);
        this.#manager.free();
        return; // nothing extra to free here.
    }

    /**
     * If this method is not called, the parameters default to those in {@linkcode FeatureSetEnrichmentState#defaults FeatureSetEnrichmentState.defaults}.
     *
     * @param {object} parameters - Parameter object, see the argument of the same name in {@linkcode FeatureSetEnrichmentState#compute FeatureSetEnrichmentState.compute} for more details.
     * Note that any `skip` property is ignored here.
     *
     * @return The object is updated with new parameters.
     * Note that the {@linkcode FeatureSetEnrichmentStandalone#ready ready} method should be called in order for the new parameters to take effect.
     */
    setParameters(parameters) {
        let { automatic, species, gene_id_column, gene_id_type, top_markers } = parameters;
        _transplantParameters(this.#parameters, automatic, species, gene_id_column, gene_id_type, top_markers);
    }

    /**
     * This should be called after construction and/or {@linkcode FeatureSetEnrichmenStandalone#setParameters setParameters}. 
     * Users should wait for the return value to resolve before calling any other methods of this class.
     * 
     * @return Feature set collections are loaded into memory. 
     * @async
     */
    async ready() {
        let { automatic, species, gene_id_column, gene_id_type, top_markers } = this.#parameters;
        if (this.#manager == null) {
            this.#manager = new FeatureSetManager; 
            this.#parameters = {}; // this gets repopulated by _buildCollections.
        }

        await _buildCollections(
            this.#parameters,
            this.#manager,
            automatic, 
            species, 
            gene_id_column, 
            gene_id_type, 
            () => this.#annotations,
            () => this.#guessFeatureTypes()
        );
    }

    /**
     * Obtain the details about the feature set collections in the reference database.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @return {object} Object containing the details about the available feature set collections,
     * see {@linkcode FeatureSetEnrichmentState#fetchCollectionDetails FeatureSetEnrichmentState.fetchCollectionDetails} for more details.
     */
    fetchCollectionDetails() {
        return this.#manager.fetchCollectionDetails();
    }

    /**
     * Obtain the details about the feature sets in the reference database.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @return {object} Object containing the details about the available feature sets,
     * see {@linkcode FeatureSetEnrichmentState#fetchSetDetails FeatureSetEnrichmentState.fetchSetDetails} for more details.
     */
    fetchSetDetails() {
        return this.#manager.fetchSetDetails();
    }

    /**
     * Obtain the size of the universe of features that were successfully mapped to features in the reference database.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @return {number} Number of features from the input dataset that were successfully mapped to at least one gene in the reference database.
     */
    fetchUniverseSize() {
        return this.#manager.fetchUniverseSize();
    }

    /**
     * Compute enrichment of top markers in each feature set.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @param {external:ScoreMarkersResults} markers - Marker detection results for an RNA modality.
     * @param {number} group - Group index of interest.
     * @param {string} effect_size - Effect size to use for ranking.
     * This should be one of `"cohen"`, `"auc"`, `"lfc"` or `"delta_detected"`.
     * @param {string} summary - Summary statistic to use for ranking.
     * This should be one of `"min"`, `"mean"` or `"min_rank"`.
     *
     * @return {object} Object containing statistics for the enrichment of the top marker genes in each feature set.
     * See {@linkcode FeatureSetEnrichmentState#computeEnrichment FeatureSetEnrichmentState.computeEnrichment} for more details.
     */
    computeEnrichment(markers, group, effect_size, summary) {
        return this.#manager.computeEnrichment(group, effect_size, summary, markers, this.#parameters.top_markers);
    }

    /**
     * Extract row indices of the members of a desired feature set of interest.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @param {number} set_id - Feature set ID, defined as an index into the arrays returned by {@linkcode FeatureSetEnrichmentStandlone#fetchSetDetails fetchSetDetails}.
     *
     * @return {Int32Array} Array containing the row indices of the RNA count matrix corresponding to the genes in the specified set.
     */
    fetchFeatureSetIndices(set_id) {
        return this.#manager.fetchFeatureSetIndices(set_id);
    }

    /**
     * @return {object} Object containing the parameters.
     */
    fetchParameters() {
        return _fetchParameters(this.#parameters);
    }

    /**
     * Compute per-cell scores for the activity of a feature set.
     * It is assumed that the {@linkcode FeatureSetEnrichmenStandalone#ready ready} method has already resolved before calling this method.
     *
     * @param {number} set_id - Feature set ID, defined as an index into the arrays returned by {@linkcode FeatureSetEnrichmentStandlone#fetchSetDetails fetchSetDetails}.
     *
     * @return {Object} Object containing the per-cell scores for the feature set activity.
     * See {@linkcode FeatureSetEnrichmentState#computePerCellScores FeatureSetEnrichmentState.computePerCellScores} for more details.
     */
    computePerCellScores(set_id) {
        if (this.#normalized == null) {
            throw new Error("no normalized matrix supplied in constructor");
        }

        let output = this.#manager.computePerCellScores(set_id, this.#normalized, this.#block);

        if (this.#backmap !== null) {
            let backfilled = new Float64Array(output.scores.length);
            backfilled.fill(Number.NaN);
            this.#backmap.forEach((x, i) => {
                backfilled[x] = output.scores[i];
            });
            output.scores = backfilled;
        }

        return output;
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, inputs, filter, normalized, markers) {
    let parameters = {};
    let cache = {};

    // Protect against old analysis states that don't have cell_labelling.
    if ("feature_set_enrichment" in handle.children) {
        let ghandle = handle.open("feature_set_enrichment");

        {
            let phandle = ghandle.open("parameters");
            parameters.collections = phandle.open("collections", { load: true }).values;
            for (const k of [ "gene_id_column", "gene_id_type", "top_markers" ]) {
                parameters[k] = phandle.open(k, { load: true }).values[0];
            }
        }
    }

    return new FeatureSetEnrichmentState(inputs, filter, normalized, markers, parameters, cache);
}
