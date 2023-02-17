import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js"

beforeAll(utils.initializeAll);
afterAll(async () => await bakana.terminate());

let files = {
    default: new bakana.TenxHdf5Dataset("files/datasets/pbmc4k-tenx.h5")
};

test("addition, fetching and removal of custom selections works correctly", async () => {
    let state = await bakana.createAnalysis();
    let params = utils.baseParams();
    await bakana.runAnalysis(state, files, params);

    {
        state.custom_selections.addSelection("evens", [0,2,4,6,8]);
        let res = state.custom_selections.fetchResults("evens");
        expect(res.RNA instanceof scran.ScoreMarkersResults).toBe(true);

        state.custom_selections.addSelection("odds", [1,3,5,7,9]);
        let res2 = state.custom_selections.fetchResults("odds");
        expect(res2.RNA instanceof scran.ScoreMarkersResults).toBe(true);

        expect(state.custom_selections.fetchSelectionIndices("evens")).toEqual([0,2,4,6,8]);
        expect(state.custom_selections.fetchSelectionIndices("odds")).toEqual([1,3,5,7,9]);

        let all = state.custom_selections.fetchSelections();
        expect(all["evens"]).toEqual([0,2,4,6,8]);
        expect(all["odds"]).toEqual([1,3,5,7,9]);
    }

    // Versus mode works correctly.
    {
        let vres = state.custom_selections.computeVersus("odds", "evens");
        expect(vres.results.RNA instanceof scran.ScoreMarkersResults).toBe(true);

        let vres2 = state.custom_selections.computeVersus("evens", "odds");
        expect(vres2.results.RNA instanceof scran.ScoreMarkersResults).toBe(true);

        let lfcs = vres.results.RNA.lfc(vres.left);
        let lfcs2 = vres2.results.RNA.lfc(vres2.left);
        lfcs2.forEach((x, i) => {
            lfcs2[i] *= -1;
        });

        expect(lfcs).toEqual(lfcs2);
    }

    // Changing the parameters triggers recomputation of all results.
    {
        let old_odd = state.custom_selections.fetchResults("odds").RNA.cohen(1);
        let old_even = state.custom_selections.fetchResults("evens").RNA.auc(1);
    
        let params2 = utils.baseParams();
        params2.custom_selections.lfc_threshold = 1;
        await bakana.runAnalysis(state, null, params2);
        expect(state.cell_filtering.changed).toBe(false);
        expect(state.custom_selections.changed).toBe(true);
        expect(state.custom_selections.fetchParameters().lfc_threshold).toBe(1);

        let latest_odd = state.custom_selections.fetchResults("odds").RNA.cohen(1);
        let latest_even = state.custom_selections.fetchResults("evens").RNA.auc(1);
        for (var i = 0; i < old_odd.length; i++) {
            expect(old_odd[i]).toBeGreaterThan(latest_odd[i]);
            expect(old_even[i]).toBeGreaterThan(latest_even[i]);
        }

        state.custom_selections.compute(0, true);
        expect(state.custom_selections.fetchResults("odds").RNA.cohen(1)).toEqual(old_odd);
        expect(state.custom_selections.fetchResults("evens").RNA.auc(1)).toEqual(old_even);
    }

    // Removal of selections works correctly.
    state.custom_selections.removeSelection("odds");
    {
        let all = state.custom_selections.fetchSelections();
        expect("odds" in all).toBe(false)
        expect("evens" in all).toBe(true)
    }

    // Check saving of results.
    await bakana.saveSingleCellExperiment(state, "custom", { directory: "miscellaneous/from-tests" });

    // Freeing.
    await bakana.freeAnalysis(state);
})
