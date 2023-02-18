#!/bin/bash

set -e
set -u

base=https://github.com/kanaverse/kana-formats/releases/download
dir=legacy
mkdir -p ${dir}

download() {
    output=${dir}/$2
    if [ ! -e $output ]
    then
        curl -L ${base}/$1 > $output
    fi
}

download zeisel-v0-latest/zeisel_tenx_20220307.kana zeisel_tenx_20220307.kana
download zeisel-v0-latest/zeisel_mtx_20220306.kana zeisel_mtx_20220306.kana

download zeisel-v1.0-latest/zeisel_tenx_20220318.kana zeisel_tenx_20220318.kana

download pbmc-v1.1-latest/pbmc-combined_tenx_20220401.kana pbmc-combined_tenx_20220401.kana
download pbmc-v1.1-latest/pbmc4k-with-custom_mtx_20220408.kana pbmc4k-with-custom_mtx_20220408.kana

download assorted-v1.2-latest/pbmc-combined-with-kmeans-and-custom_tenx_20220525.kana pbmc-combined-with-kmeans-and-custom_tenx_20220525.kana
download assorted-v1.2-latest/pbmc4k-with-kmeans-and-custom_mtx_20220525.kana pbmc4k-with-kmeans-and-custom_mtx_20220525.kana

download zeisel-v2.1-latest/zeisel_tenx_20230101.kana zeisel_tenx_20230101.kana 
download pbmc-v2.1-latest/pbmc-combined_mtx_20230101.kana pbmc-combined_mtx_20230101.kana
download pbmc-v2.1-latest/pbmc-multiple_tenx_20230101.kana pbmc-multiple_tenx_20230101.kana 
