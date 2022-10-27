import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js";
import * as fs from "fs";

beforeAll(utils.initializeAll);
afterAll(async () => await bakana.terminate());

let files = {
    default: new bakana.TenxMatrixMarketDataset(
            "files/datasets/pbmc3k-matrix.mtx.gz",
            "files/datasets/pbmc3k-features.tsv.gz",
            "files/datasets/pbmc3k-barcodes.tsv.gz"
        )
};

test("saving to and loading from a kana file works correctly (embedded)", async () => {
    let params = utils.baseParams();
    let state = await bakana.createAnalysis();
    await bakana.runAnalysis(state, files, params);
    let ref_pca = state.pca.summary();

    // Saving to a kana file.
    const path = "TEST_kana_state.h5";
    let collected = await bakana.saveAnalysis(state, path);

    const kpath = "TEST_state.kana";
    let res = await bakana.createKanaFile(path, collected.collected, { outputPath: kpath });
    expect(collected.total > 0).toBe(true);
    expect(fs.statSync(res).size).toBe(24 + fs.statSync(path).size + collected.total);

    // Alright - trying to unpack everything.
    let tmp = "TEST_kana_loader";
    if (fs.existsSync(tmp)) {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    fs.mkdirSync(tmp);

    const round_trip = "TEST_kana_state_again.h5";

    let loader = await bakana.parseKanaFile(kpath, round_trip, { stageDir: tmp });
    utils.validateState(round_trip);
    let reloaded = await bakana.loadAnalysis(round_trip, loader);

    // Checking that we got something that was reasonable.
    expect(reloaded.pca.summary()).toEqual(ref_pca);

    // Releasing all memory.
    await bakana.freeAnalysis(state);
    await bakana.freeAnalysis(reloaded);

    // Deleting the files.
    bakana.removeHDF5File(path);
    expect(fs.existsSync(path)).toBe(false); // properly removed.
    bakana.removeHDF5File(round_trip);
    expect(fs.existsSync(round_trip)).toBe(false); // properly removed.
})

test("saving to and loading from a kana file works with links", async () => {
    let params = utils.baseParams();
    let state = await bakana.createAnalysis();
    await bakana.runAnalysis(state, files, params);
    let ref_pca = state.pca.summary();

    // Links just re-use the file path for our Node tests, which is unique enough!
    let old_create = bakana.setCreateLink(path => path);
    let old_resolve = bakana.setResolveLink(id => id)

    // Saving to a kana file.
    const path = "TEST_kana_state2.h5";
    await bakana.saveAnalysis(state, path, { embedded: false });

    const kpath = "TEST_state2.kana";
    let res = await bakana.createKanaFile(path, null, { outputPath: kpath });
    expect(fs.statSync(res).size).toBe(24 + fs.statSync(path).size);

    bakana.removeHDF5File(path);
    expect(fs.existsSync(path)).toBe(false); // properly removed.

    // Alright - trying to unpack everything.
    const round_trip = "TEST_kana_state_again2.h5";
    let loader = await bakana.parseKanaFile(kpath, round_trip);
    utils.validateState(round_trip, false);
    let reloaded = await bakana.loadAnalysis(round_trip, loader);

    // Checking that we got something that was reasonable.
    expect(reloaded.pca.summary()).toEqual(ref_pca);

    // Reverting the linkers.
    bakana.setCreateLink(old_create);
    bakana.setResolveLink(old_resolve);

    // Releasing all memory.
    await bakana.freeAnalysis(state);
    await bakana.freeAnalysis(reloaded);

    // Deleting the files.
    bakana.removeHDF5File(path);
    bakana.removeHDF5File(round_trip);
})
