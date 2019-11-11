//@ts-check

"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

const config = {
    target: "node",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "extension.js",
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]"
    },
    externals: {
        vscode: "commonjs vscode"
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: "ts-loader"
                    }
                ]
            }
        ]
    },
    plugins: [
        new CopyPlugin([
            {
                from: path.resolve("node_modules/source-map/lib/mappings.wasm")
            }
        ])
    ],
    node: {
        __dirname: false
    }
};

module.exports = (env, argv) => {
    if (argv.mode === "development") {
        config.devtool = "source-map";
        config.entry = "./src/extension.ts";
    }

    if (argv.mode === "production") {
        config.entry = "./src/debugAdapter.ts";
    }

    return config;
};
