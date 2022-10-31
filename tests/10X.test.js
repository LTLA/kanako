import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js";

beforeAll(utils.initializeAll);
afterAll(async () => await bakana.terminate());

test("runAnalysis works correctly (10X)", async () => {
    let attempts = new Set();
    let started = step => {
        attempts.add(step);
    };

    let contents = {};
    let finished = (step, res) => {
        contents[step] = res;
    };

    let h5path = "files/datasets/pbmc4k-tenx.h5";
    let files = {
        default: new bakana.TenxHdf5Dataset(h5path)
    };

    let state = await bakana.createAnalysis();
    let params = utils.baseParams();
    let res = await bakana.runAnalysis(state, files, params, { startFun: started, finishFun: finished });

    expect(attempts.has("quality_control")).toBe(true);
    expect(attempts.has("pca")).toBe(true);
    expect(contents.quality_control instanceof Object).toBe(true);
    expect(contents.pca instanceof Object).toBe(true);
    expect(contents.feature_selection instanceof Object).toBe(true);
    expect(contents.cell_labelling instanceof Object).toBe(true);
    expect(contents.marker_detection instanceof Object).toBe(true);

    // Input reorganization is done correctly.
    {
        let loaded = state.inputs.fetchCountMatrix();
        let loaded_ids = state.inputs.fetchRowIds();
        let loaded_names = state.inputs.fetchGenes().column("id");

        let simple = scran.initializeSparseMatrixFromHDF5(h5path, "matrix", { layered: false });
        let simple_names = (new scran.H5File(h5path)).open("matrix").open("features").open("id", { load: true }).values;

        utils.checkReorganization(simple.matrix, simple.row_ids, simple_names, loaded, loaded_ids, loaded_names);
        simple.matrix.free();
    }

    // Saving and loading.
    const path = "TEST_state_10X.h5";
    let collected = await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    expect(collected.collected.length).toBe(1);
    expect(typeof(collected.collected[0])).toBe("string");

    let offsets = utils.mockOffsets(collected.collected);
    let reloaded = await bakana.loadAnalysis(
        path, 
        (offset, size) => offsets[offset]
    );

    let new_params = bakana.retrieveParameters(reloaded);
    expect(new_params.quality_control instanceof Object).toBe(true);
    expect(new_params.pca instanceof Object).toBe(true);

    // Freeing.
    await bakana.freeAnalysis(state);
    await bakana.freeAnalysis(reloaded);
})
