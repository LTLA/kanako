import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import * as rna_qc_module from "./rna_quality_control.js";
import * as adt_qc_module from "./adt_quality_control.js";
import * as crispr_qc_module from "./crispr_quality_control.js";
import * as inputs_module from "./inputs.js";

export const step_name = "cell_filtering";

function find_usable_upstream_states(qc_states, in_use) {
    let tmp = utils.findValidUpstreamStates(qc_states);
    let to_use = [];
    for (const k of tmp) {
        if (in_use[k]) {
            to_use.push(qc_states[k]);
        }
    }
    return to_use;
}

/**
 * This step filters the count matrices to remove low-quality cells,
 * based on metrics and thresholds computed in {@linkplain RnaQualityControlState} and friends.
 * It wraps the [`filterCells`](https://jkanche.com/scran.js/global.html#filterCells) function
 * from [**scran.js**](https://github.com/jkanche/scran.js).
 * For multi-modal datasets, this can combine quality calls from all valid modalities; 
 * a cell is removed if it is considered low-quality in any individual modality.
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class CellFilteringState {
    #inputs;
    #qc_states;
    #cache;
    #parameters;

    constructor(inputs, qc_states, parameters = null, cache = null) {
        if (!(inputs instanceof inputs_module.InputsState)) {
            throw new Error("'inputs' should be an InputsState object");
        }
        this.#inputs = inputs;

        if (!(qc_states.RNA instanceof rna_qc_module.RnaQualityControlState)) {
            throw new Error("'qc_states.RNA' should be a RnaQualityControlState object");
        }
        if (!(qc_states.ADT instanceof adt_qc_module.AdtQualityControlState)) {
            throw new Error("'qc_states.ADT' should be a AdtQualityControlState object");
        }
        if (!(qc_states.CRISPR instanceof crispr_qc_module.CrisprQualityControlState)) {
            throw new Error("'qc_states.CRISPR' should be a CrisprQualityControlState object");
        }
        this.#qc_states = qc_states;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.block_buffer);
        utils.freeCache(this.#cache.discard_buffer);
        utils.freeCache(this.#cache.matrix);
    }

    /***************************
     ******** Getters **********
     ***************************/

    /**
     * @return {external:MultiMatrix} A {@linkplain external:MultiMatrix MultiMatrix} object containing the filtered and normalized matrices for all modalities,
     * available after running {@linkcode CellFilteringState#compute compute}.
     */
    fetchFilteredMatrix() {
        if (!("matrix" in this.#cache)) {
            this.#raw_compute_matrix();
        }
        return this.#cache.matrix;
    }

    /**
     * @return {Int32WasmArray} Array of length equal to the number of cells after filtering, 
     * containing the block assignment for each cell.
     * This is available after running {@linkcode CellFilteringState#compute compute}.
     * Alternatively `null` if no blocks are present in the dataset.
     */
    fetchFilteredBlock() {
        if (!("block_buffer" in this.#cache)) {
            this.#raw_compute_block();
        }
        return this.#cache.block_buffer;
    }

    /**
     * @return {?Uint8WasmArray} Combined discard vector, i.e., an array of length equal to the number of cells in the dataset,
     * indicating whether each cell should be removed.
     * This is available after running {@linkcode CellFilteringState#compute compute}.
     * Alternatively `null`, if no upstream filtering steps were performed.
     */
    fetchDiscards() {
        if ("discard_buffer" in this.#cache) {
            return this.#cache.discard_buffer;
        } else {
            return null;
        }
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

    #raw_compute_matrix() {
        utils.freeCache(this.#cache.matrix);
        this.#cache.matrix = new scran.MultiMatrix;

        let inputs = this.#inputs.fetchCountMatrix();
        for (const a of inputs.available()) {
            let src = inputs.get(a);

            let sub;
            if ("discard_buffer" in this.#cache) {
                sub = scran.filterCells(src, this.#cache.discard_buffer);
            } else {
                sub = src.clone();
            }

            this.#cache.matrix.add(a, sub);
        }
    }

    #raw_compute_block() {
        utils.freeCache(this.#cache.block_buffer);

        let block = this.#inputs.fetchBlock();
        if (block !== null) {
            if ("discard_buffer" in this.#cache) {
                // Filtering on the block. Might as well force a load of the
                // matrix, it'll be needed once we have the blocks anyway.
                let filtered_ncols = this.fetchFilteredMatrix().numberOfColumns();
                let bcache = utils.allocateCachedArray(filtered_ncols, "Int32Array", this.#cache, "block_buffer");
                scran.filterBlock(block, this.#cache.discard_buffer, { buffer: bcache });
            } else {
                this.#cache.block_buffer = block.view();
            }
        } else {
            this.#cache.block_buffer = null;
        }
    }

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     * Each argument is taken from the property of the same name in the `cell_filtering` property of the `parameters` of {@linkcode runAnalysis}.
     *
     * @param {boolean} use_rna - Whether to use the RNA-derived QC metrics for filtering.
     * @param {boolean} use_adt - Whether to use the ADT-derived QC metrics for filtering.
     * @param {boolean} use_crispr - Whether to use the CRISPR-derived QC metrics for filtering.
     *
     * @return The object is updated with the new results.
     */
    compute(use_rna, use_adt, use_crispr) {
        this.changed = false;

        if (this.#inputs.changed) {
            this.changed = true;
        }

        if (this.#parameters.use_rna !== use_rna || this.#parameters.use_adt !== use_adt || this.#parameters.use_crispr !== use_crispr) {
            this.#parameters.use_rna = use_rna;
            this.#parameters.use_adt = use_adt;
            this.#parameters.use_crispr = use_crispr;
            this.changed = true;
        }

        let to_use = find_usable_upstream_states(this.#qc_states, { RNA: use_rna, ADT: use_adt, CRISPR: use_crispr });
        if (!this.changed) {
            for (const u of to_use) {
                if (u.changed) {
                    this.changed = true;
                    break;
                }
            }
        }

        if (this.changed) {
            if (to_use.length > 0) {
                let first = to_use[0].fetchDiscards();

                if (to_use.length > 1) {
                    // A discard signal in any modality causes the cell to be removed. 
                    let disc_buffer = utils.allocateCachedArray(first.length, "Uint8Array", this.#cache, "discard_buffer");
                    disc_buffer.fill(0);

                    let disc_arr = disc_buffer.array();
                    for (const u of to_use) {
                        u.fetchDiscards().forEach((y, i) => { disc_arr[i] |= y; });
                    }
                } else {
                    // If there's only one valid modality, we just create a view on it
                    // to avoid unnecessary duplication.
                    utils.freeCache(this.#cache.discard_buffer);
                    this.#cache.discard_buffer = first.view();
                }

            } else {
                // Deleting this so that serialization will behave correctly.
                utils.freeCache(this.#cache.discard_buffer);
                delete this.#cache.discard_buffer;
            }

            this.#raw_compute_matrix();
            this.#raw_compute_block();
        }
    }

    static defaults() {
        return {
            use_rna: true,
            use_adt: true,
            use_crispr: true
        };
    }

    /**
     * Apply the same filter to an array of data for each cell in the unfiltered dataset.
     * Any calls to this method should be done after running {@linkcode CellFilteringState#compute compute}.
     *
     * @param {Array|TypedArray} Any array-like object of length equal to the number of cells in the unfiltered dataset.
     * 
     * @return {Array|TypedArray} An array-like object of the same type as `x`,
     * where all elements corresponding to low-quality cells have been discarded.
     * This will have number of columns equal to that of {@linkcode CellFilteringState#fetchFilteredMatrix fetchFilteredMatrix}.
     */
    applyFilter(x) {
        let expect_len = this.#inputs.fetchCountMatrix().numberOfColumns();
        if (expect_len != x.length) {
            throw new Error("length of 'x' should be equal to the number of cells in the unfiltered dataset");
        }

        if (!("discard_buffer" in this.#cache)) {
            return x.slice(); // making a copy.
        } else {
            let discard = this.#cache.discard_buffer.array();
            return x.filter((y, i) => !discard[i]);
        }
    }

    /**
     * Undo the effect of filtering on an array of indices.
     * This is primarily useful for adjusting indices from downstream steps 
     * (e.g., {@linkcode CustomSelectionsState#fetchSelectionIndices CustomSelectionsState.fetchSelectionIndices})
     * so that it can be used in {@linkcode subsetInputs}.
     *
     * @param {Array|TypedArray} indices - Array of column indices to the filtered matrix.
     * Note that this will be modified in-place.
     *
     * @return Entries of `indices` are replaced with indices to the unfiltered matrix.
     */
    undoFilter(indices) {
        let max_index = this.fetchFilteredMatrix().numberOfColumns();
        for (const x of indices) {
            if (x < 0 || x >= max_index) {
                throw new Error("entries of 'indices' should be less than the number of cells in the filtered dataset");
            }
        }

        if (!('discard_buffer' in this.#cache)) {
            return;
        }

        let keep = [];
        this.#cache.discard_buffer.forEach((x, i) => {
            if (x == 0) {
                keep.push(i);
            }
        });

        indices.forEach((x, i) => {
            indices[i] = keep[x];
        });
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        let ghandle = handle.createGroup(step_name);

        {
            let phandle = ghandle.createGroup("parameters"); 
            phandle.writeDataSet("use_rna", "Uint8", [], this.#parameters.use_rna);
            phandle.writeDataSet("use_adt", "Uint8", [], this.#parameters.use_adt);
            phandle.writeDataSet("use_crispr", "Uint8", [], this.#parameters.use_crispr);
        }

        let rhandle = ghandle.createGroup("results"); 

        // If it's not present, then none of the upstream QC states applied
        // any filtering, so we don't really have anything to do here.
        if ("discard_buffer" in this.#cache) {
            let disc = this.#cache.discard_buffer;

            // If it's present and it's not a view, we save it; otherwise, we
            // skip it, under the assumption that only one of the upstream QC
            // states contains the discard vector.
            if (disc.owner === null) {
                rhandle.writeDataSet("discards", "Uint8", null, disc);
            }

        }
    }
}

export function unserialize(handle, inputs, qc_states) {
    let parameters = CellFilteringState.defaults();
    let cache = {};
    let output;

    try {
        if (step_name in handle.children) {
            let ghandle = handle.open(step_name);

            if ("parameters" in ghandle.children) {
                let phandle = ghandle.open("parameters");
                parameters.use_rna = phandle.open("use_rna", { load: true }).values[0] > 0;
                parameters.use_adt = phandle.open("use_adt", { load: true }).values[0] > 0;
                parameters.use_crispr = phandle.open("use_crispr", { load: true }).values[0] > 0;
            }

            let rhandle = ghandle.open("results");
            if ("discards" in rhandle.children) {
                let discards = rhandle.open("discards", { load: true }).values; 
                cache.discard_buffer = scran.createUint8WasmArray(discards.length);
                cache.discard_buffer.set(discards);
            }
        } 

        if (!("discard_buffer" in cache)) {
            let to_use = find_usable_upstream_states(qc_states, { RNA: parameters.use_rna, ADT: parameters.use_adt, CRISPR: parameters.use_crispr });

            if (to_use.length == 1) {
                // We figure out which upstream QC state contains the discard vector
                // and create a view on it so that our discard_buffer checks work properly.
                // (v1 and earlier also implicitly falls in this category.)
                cache.discard_buffer = to_use[0].fetchDiscards().view();
            } else if (to_use.length == 0) {
                // No-op; we don't need to define discard_buffer.
                ;
            } else {
                throw new Error("no more than one upstream QC state should be valid if 'discards' is not available");
            }
        }

        output = new CellFilteringState(inputs, qc_states, parameters, cache);
    } catch (e) {
        utils.freeCache(cache.discard_buffer);
        utils.freeCache(output);
        throw e;
    }

    return output;
}
