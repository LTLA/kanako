import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js"

beforeAll(utils.initializeAll);
afterAll(async () => await bakana.terminate());

test("switching between clustering methods (SNN first)", async () => {
    let files = {
        default: new bakana.TenxHdf5Dataset("files/datasets/pbmc4k-tenx.h5")
    };

    // First running the analysis with SNN graph,
    // and confirming that only SNN graph results are reported.
    let state = await bakana.createAnalysis();
    let paramcopy = utils.baseParams();
    await bakana.runAnalysis(state, files, paramcopy);

    const path = "TEST_state_clusters.h5";
    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(false);

        let shandle = handle.open("snn_graph_cluster");
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(true);
    }

    // Now trying with k-means. This should cause both sets of
    // results to be saved, as both clusterings are still valid.
    paramcopy.choose_clustering.method = "kmeans";

    await bakana.runAnalysis(state, files, paramcopy);
    expect(state.pca.changed).toBe(false);
    expect(state.snn_graph_cluster.changed).toBe(false);
    expect(state.kmeans_cluster.changed).toBe(true);
    expect(state.choose_clustering.changed).toBe(true);

    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(true);

        let shandle = handle.open("snn_graph_cluster");
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(true);
    }

    // Checking that invalidation of the results behaves correctly.
    // If we change the parameters but we're still on the old set of
    // results, the SNN graph results don't get rerun and the results get wiped.
    paramcopy.snn_graph_cluster.resolution = 0.77;

    await bakana.runAnalysis(state, files, paramcopy);
    expect(state.pca.changed).toBe(false);
    expect(state.snn_graph_cluster.changed).toBe(true);
    expect(state.kmeans_cluster.changed).toBe(false);
    expect(state.choose_clustering.changed).toBe(false);

    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(true);

        let shandle = handle.open("snn_graph_cluster");
        let sphandle = shandle.open("parameters");
        expect(sphandle.open("resolution", { load: true }).values[0]).toEqual(0.77);
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(false);
    }

    // Freeing all states.
    await bakana.freeAnalysis(state);
});

test("switching between clustering methods (k-means first)", async () => {
    let files = {
        default: new bakana.TenxMatrixMarketDataset("files/datasets/pbmc3k-matrix.mtx.gz", "files/datasets/pbmc3k-features.tsv.gz", null)
    };

    let state = await bakana.createAnalysis();
    let paramcopy = utils.baseParams();
    paramcopy.choose_clustering = { method: "kmeans" };

    await bakana.runAnalysis(state, files, paramcopy);
    expect(state.snn_graph_cluster.changed).toBe(true);
    expect(state.kmeans_cluster.changed).toBe(true);

    const path = "TEST_state_clusters.h5";
    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(true);

        let shandle = handle.open("snn_graph_cluster");
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(false);
    }

    // Trying with a different clustering method.
    paramcopy.choose_clustering.method = "snn_graph"; 

    await bakana.runAnalysis(state, files, paramcopy);
    expect(state.snn_graph_cluster.changed).toBe(true);
    expect(state.kmeans_cluster.changed).toBe(false);

    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(true);

        let shandle = handle.open("snn_graph_cluster");
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(true);
    }

    // Checking that invalidation works.
    paramcopy.kmeans_cluster.k = 7;

    await bakana.runAnalysis(state, files, paramcopy);
    expect(state.snn_graph_cluster.changed).toBe(false);
    expect(state.kmeans_cluster.changed).toBe(true);

    await bakana.saveAnalysis(state, path);
    utils.validateState(path);
    {
        let handle = new scran.H5File(path);
        let khandle = handle.open("kmeans_cluster");
        let kphandle = khandle.open("parameters");
        expect(kphandle.open("k", { load: true }).values[0]).toEqual(7);
        let krhandle = khandle.open("results");
        expect("clusters" in krhandle.children).toBe(false);

        let shandle = handle.open("snn_graph_cluster");
        let srhandle = shandle.open("results");
        expect("clusters" in srhandle.children).toBe(true);
    }

    // Freeing all states.
    await bakana.freeAnalysis(state);
});
