import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import * as nutils from "./utils/normalization.js";
import * as qc_module from "./quality_control.js";
import * as filter_module from "./cell_filtering.js";

export const step_name = "normalization";

/**
 * This step performs normalization and log-transformation on the QC-filtered matrix from the {@linkplain QualityControlState}.
 * It wraps the `logNormCounts` function from [**scran.js**](https://github.com/jkanche/scran.js).
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class NormalizationState extends nutils.NormalizationStateBase {
    #qc
    #filter;
    #parameters;
    #cache;

    constructor(qc, filter, parameters = null, cache = null) {
        super();

        if (!(qc instanceof qc_module.QualityControlState)) {
            throw new Error("'filt' should be a State object from './quality_control.js'");
        }
        this.#qc = qc;

        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filt' should be a State object from './cell_filtering.js'");
        }
        this.#filter = filter;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.matrix);
        utils.freeCache(this.#cache.sum_buffer);
    }

    /***************************
     ******** Getters **********
     ***************************/

    valid() {
        return true;
    }

    /**
     * @return {ScranMatrix} A ScranMatrix object containing the normalized expression values.
     */
    fetchNormalizedMatrix() {
        if (!("matrix" in this.#cache)) {
            this.#raw_compute();
        }
        return this.#cache.matrix;
    }

    /**
     * @return {Float64WasmArray} Array of length equal to the number of cells, 
     * containing the gene expression size factor for each cell.
     */
    fetchSizeFactors() {
        return this.#cache.sum_buffer;
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

    #raw_compute() {
        var mat = this.#filter.fetchFilteredMatrix().get("RNA");
        let buffer = nutils.subsetSums(this.#qc, this.#filter, mat, this.#cache, "sum_buffer");

        var block = this.#filter.fetchFilteredBlock();
        utils.freeCache(this.#cache.matrix);
        this.#cache.matrix = scran.logNormCounts(mat, { sizeFactors: buffer, block: block, allowZeros: true });
        return;
    }

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     *
     * @return The object is updated with new results.
     */
    compute() {
        this.changed = false;
        if (this.#qc.changed || this.#filter.changed) {
            this.changed = true;
        } 

        if (this.changed) {
            this.#raw_compute();
        }
        return;
    }

    static defaults() {
        return {};
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        // Token effort.
        let ghandle = handle.createGroup("normalization");
        ghandle.createGroup("parameters"); 
        ghandle.createGroup("results"); 
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, qc, filter) {
    return new NormalizationState(qc, filter);
}
