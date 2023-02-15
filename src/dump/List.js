import * as pako from "pako";
import * as wa from "wasmarrays.js";

function dump_internal(x) {
    let output;

    if (x instanceof Array) {
        output = { "type": "list", "values": [] };

        if (x.length) {
            let all_strings = true;
            let all_bools = true;
            for (const e of x) {
                if (e !== null) {
                    if (typeof e !== "string") {
                        all_strings = false;
                    } else if (typeof e !== "boolean") {
                        all_bools = false;
                    }
                }
            }

            if (all_strings) {
                output.type = "string";
                output.values = v;
            } else if (all_bools) {
                output.type = "boolean";
                output.values = v;
            } else {
                for (const e of v) {
                    output.values.push(dump_internal(e));
                }
            }
        }

    } else if (x instanceof Object) {
        output = { "type": "list", "values": [], "names": [] };
        for (const [k, v] of Object.entries(x)) {
            output.names.push(k);
            output.values.push(dumpList(v));
        }

    } else if (x instanceof Int32Array) {
        output = { "type": "integer", "values": Array.from(x) }

    } else if (x instanceof wa.Int32WasmArray) {
        output = { "type": "integer", "values": Array.from(x.array()) }

    } else if (x instanceof Float64Array) {
        output = { "type": "number", "values": Array.from(x) }

    } else if (x instanceof wa.Float64WasmArray) {
        output = { "type": "number", "values": Array.from(x.array()) }

    } else if (typeof x == "number") {
        output = { "type": "number", "values": [x] };

    } else if (typeof x == "string") {
        output = { "type": "string", "values": [x] };

    } else if (typeof x == "boolean") {
        output = { "type": "boolean", "values": [x] };

    } else {
        throw new Error("don't know how to save entry '" + k + "' of type '" + typeof x + "'");
    }

    return output;
}

export function dumpList(x, path) {
    let values = dump_internal(x);
    let encoded = JSON.stringify(values);
    let contents = pako.gzip(encoded);
    return {
        metadata: {
            "$schema": "json_simple_list/v1.json",
            "path": path + "/simple.json.gz",
            "simple_list": {
                "children": []
            },
            "json_simple_list": {
                "compression": "gzip"
            }
        },
        contents: contents
    };
}
