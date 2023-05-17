import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js";
import * as valkana from "valkana";

beforeAll(utils.initializeAll);
afterAll(async () => await bakana.terminate());

test.skip("reanalysis from a v0 analysis works correctly (10X)", async () => {
    const h5path = "TEST_v0_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/zeisel_tenx_20220307.kana", h5path);
    expect(loader.version).toBe(0);
    // valkana.validateState(h5path, true, 0); // Gave up, doesn't look like a valid v0 file, actually.

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("cell_labelling" in new_params).toBe(true);
    expect("kmeans_cluster" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v0 analysis works correctly (MatrixMarket)", async () => {
    const h5path = "TEST_v0_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/zeisel_mtx_20220306.kana", h5path);
    expect(loader.version).toBe(0);
    // valkana.validateState(h5path, true, 0); // Gave up, doesn't look like a valid v0 file, actually.

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("cell_labelling" in new_params).toBe(true);
    expect("kmeans_cluster" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v1.0 analysis works correctly (10X)", async () => {
    const h5path = "TEST_v1.0_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/zeisel_tenx_20220318.kana", h5path);
    expect(loader.version).toBe(1000000);
    // valkana.validateState(h5path, true, 1000000); // Gave up, doesn't look like a valid v1.0 file, actually.

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("cell_labelling" in new_params).toBe(true);
    expect("kmeans_cluster" in new_params).toBe(true);
    expect(new_params.snn_graph_cluster.scheme).toBe("rank"); // recover something from mis-formatted files.

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v1.1 analysis works correctly (10X combined)", async () => {
    const h5path = "TEST_v1.1_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc-combined_tenx_20220401.kana", h5path);
    expect(loader.version).toBe(1001000);
    valkana.validateState(h5path, true, 1001000);

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckBlocked(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("adt_normalization" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v1.1 analysis works correctly (MatrixMarket)", async () => {
    const h5path = "TEST_v1.1_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc4k-with-custom_mtx_20220408.kana", h5path);
    expect(loader.version).toBe(1001000);
    valkana.validateState(h5path, true, 1001000);

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("adt_normalization" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v1.2 analysis works correctly (10X combined)", async () => {
    const h5path = "TEST_v1.2_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc-combined-with-kmeans-and-custom_tenx_20220525.kana", h5path);
    expect(loader.version).toBe(1002000);
    // valkana.validateState(h5path, true, 1002000); // Gave up, doesn't look like a valid 1.2 file, actually.

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckBlocked(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("adt_normalization" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v1.2 analysis works correctly (MatrixMarket)", async () => {
    const h5path = "TEST_v1.2_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc4k-with-kmeans-and-custom_mtx_20220525.kana", h5path);
    expect(loader.version).toBe(1002000);
    // valkana.validateState(h5path, true, 1002000); // Gave up, doesn't look like a valid 1.2 file, actually.

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // Missing steps are filled in.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("adt_normalization" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v2.1 analysis works correctly (10X single)", async () => {
    const h5path = "TEST_v2.1_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/zeisel_tenx_20230101.kana", h5path);
    expect(loader.version).toBe(2001000);
    valkana.validateState(h5path, true, 2001000); 

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckStandard(reloaded);

    // New names are in use.
    let new_params = bakana.retrieveParameters(reloaded);
    expect("rna_quality_control" in new_params).toBe(true);
    expect("rna_normalization" in new_params).toBe(true);
    expect("rna_pca" in new_params).toBe(true);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v2.1 analysis works correctly (10X multiple)", async () => {
    const h5path = "TEST_v2.1_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc-multiple_tenx_20230101.kana", h5path);
    expect(loader.version).toBe(2001000);
    valkana.validateState(h5path, true, 2001000); 

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckBlocked(reloaded);

    // Correctly loads multiple blocks.
    expect(reloaded.inputs.fetchBlock()).not.toBeNull();
    expect(reloaded.inputs.fetchBlockLevels().length).toBe(2);

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})

test.skip("reanalysis from a v2.1 analysis works correctly (MatrixMarket combined)", async () => {
    const h5path = "TEST_v2.1_state.h5";
    let loader = await bakana.parseKanaFile("files/legacy/pbmc-combined_mtx_20230101.kana", h5path);
    expect(loader.version).toBe(2001000);
    valkana.validateState(h5path, true, 2001000); 

    let reloaded = await bakana.loadAnalysis(h5path, loader.load);
    await utils.overlordCheckBlocked(reloaded);

    // Correctly identifies the blocking factor.
    expect(reloaded.inputs.fetchBlock()).not.toBeNull();
    expect(reloaded.inputs.fetchBlockLevels().length).toBe(2);
    expect(reloaded.inputs.fetchParameters().block_factor).toBe('3k');

    // Cleaning up.
    await bakana.freeAnalysis(reloaded);
})


