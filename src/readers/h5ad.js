import * as scran from "scran.js";
import * as rutils from "./utils/index.js";
import * as afile from "../abstract/file.js";

export function abbreviate(args) {
    return { 
        "format": "H5AD", 
        "h5": rutils.formatFile(args.h5, true)
    };
}

function extract_features(handle) {
    let genes = null;

    if ("var" in handle.children && handle.children["var"] == "Group") {
        let vhandle = handle.open("var");
        let index = rutils.extractHDF5Strings(vhandle, "_index");
        if (index !== null) {
            genes = { "_index": index };

            for (const [key, val] of Object.entries(vhandle.children)) {
                if (val === "DataSet" && (key.match(/name/i) || key.match(/symb/i))) {
                    let dhandle2 = vhandle.open(key);
                    if (dhandle2.type == "String") {
                        genes[key] = dhandle2.load();
                    }
                }
            }
        }
    }

    return genes;
}

function extract_annotations(handle, { summary = false, summaryLimit = 50 } = {}) {
    let annotations = null;

    if ("obs" in handle.children && handle.children["obs"] == "Group") {
        let ohandle = handle.open("obs");
        annotations = {};

        // Maybe it has names, maybe not, who knows; let's just add what's there.
        let index = rutils.extractHDF5Strings(ohandle, "_index");
        if (index !== null) {
            annotations["_index"] = index;
        }

        for (const [key, val] of Object.entries(ohandle.children)) {
            if (val != "DataSet") {
                continue;
            }
            let dhandle = ohandle.open(key);

            if (dhandle.type != "Other") {
                let values = dhandle.load();
                if (summary) {
                    annotations[key] = rutils.summarizeArray(values, { limit: summaryLimit });
                } else {
                    annotations[key] = values;
                }
            }
        }

        if ("__categories" in ohandle.children && ohandle.children["__categories"] == "Group") {
            let chandle = ohandle.open("__categories");

            for (const [key, val] of Object.entries(chandle.children)) {
                if (key in annotations) {
                    let cats = rutils.extractHDF5Strings(chandle, key);
                    if (cats !== null) {
                        if (summary) {
                            annotations[key] = rutils.summarizeArray(cats, { limit: summaryLimit });
                        } else {
                            let old = annotations[key];

                            // don't use map() as we need to handle IntArray values in 'old'.
                            let temp = new Array(old.length);
                            old.forEach((x, i) => {
                                temp[i] = cats[x]
                            }); 

                            annotations[key] = temp;
                        }
                    }
                }
            }
        }
    }

    return annotations;
}

export function preflight(args) {
    let output = {};
    let formatted = rutils.formatFile(args.h5, false)

    const tmppath = afile.realizeH5(formatted.content);
    try {
        let handle = new scran.H5File(tmppath);
        let raw_gene_info = extract_features(handle);

        let split_out = rutils.presplitByFeatureType(raw_gene_info);
        if (split_out !== null) {
            output.genes = split_out.genes;
        } else {
            output.genes = { RNA: raw_gene_info };
        }

        output.annotations = extract_annotations(handle, { summary: true });
    } finally {
        afile.removeH5(tmppath);
    }

    return output;
}

export class Reader {
    #h5;

    constructor(args, formatted = false) {
        if (formatted) {
            this.#h5 = args;
        } else {
            this.#h5 = rutils.formatFile(args.h5, false);
        }
        return;
    }

    load() {
        let output = { matrix: new scran.MultiMatrix };

        const tmppath = afile.realizeH5(this.#h5.content);
        try {
            let loaded = scran.initializeSparseMatrixFromHDF5(tmppath, "X");
            let out_mat = loaded.matrix;
            let out_ids = loaded.row_ids;
            output.matrix.add("RNA", out_mat);

            let handle = new scran.H5File(tmppath);
            let raw_gene_info = extract_features(handle); 
            output.genes = { RNA: rutils.reorganizeGenes(out_mat, out_ids, raw_gene_info) };

            output.row_ids = { RNA: out_ids };
            output.annotations = extract_annotations(handle);

        } catch (e) {
            scran.free(output.matrix);
            throw e;
        } finally {
            afile.removeH5(tmppath);
        }

        return output;
    }

    format() {
        return "H5AD";
    }

    async serialize(embeddedSaver) {
        return [await rutils.standardSerialize(this.#h5, "h5", embeddedSaver)];
    }
}

export async function unserialize(values, embeddedLoader) {
    return new Reader(await rutils.standardUnserialize(values[0], embeddedLoader), true);
}
