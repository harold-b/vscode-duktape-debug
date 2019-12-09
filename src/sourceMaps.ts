/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from "path";
import * as FS from "fs";
import { SourceMapConsumer, MappedPosition, Position, BasicSourceMapConsumer } from "source-map";
import * as PathUtils from "./pathUtilities";

const util = require("../node_modules/source-map/lib/util.js");

export interface MappingResult {
    path: string; // absolute path
    content?: string; // optional content of source (source inlined in source map)
    line: number;
    column: number;
}

export enum Bias {
    GREATEST_LOWER_BOUND = 1,
    LEAST_UPPER_BOUND = 2
}

export interface ISourceMaps {
    /*
     * Map source language path to generated path.
     * Returns null if not found.
     */
    MapPathFromSource(path: string, roots: string[]): SourceMap;

    /*
     * Map location in source language to location in generated code.
     * line and column are 0 based.
     */
    MapFromSource(path: string, line: number, column: number, roots: string[], bias?: Bias): MappingResult;

    /*
     * Map location in generated code to location in source language.
     * line and column are 0 based.
     */
    MapToSource(path: string, line: number, column: number, roots: string[], bias?: Bias): MappingResult;
}

export class SourceMaps implements ISourceMaps {
    private static SOURCE_MAPPING_MATCHER = new RegExp("//[#@] ?sourceMappingURL=(.+)$");

    private _allSourceMaps: { [id: string]: SourceMap } = {}; // map file path -> SourceMap
    private _generatedToSourceMaps: { [id: string]: SourceMap } = {}; // generated file -> SourceMap
    private _sourceToGeneratedMaps: { [id: string]: SourceMap } = {}; // source file -> SourceMap
    private _generatedCodeDirectory: string;

    public constructor(generatedCodeDirectory: string) {
        this._generatedCodeDirectory = generatedCodeDirectory;
    }

    public MapPathFromSource(pathToSource: string, roots: string[]): SourceMap {
        const map = this.FindSourceToGeneratedMapping(pathToSource, roots);
        if (map) {
            return map;
        }
        return null;
    }

    public MapFromSource(
        pathToSource: string,
        line: number,
        column: number,
        roots: string[],
        bias?: Bias
    ): MappingResult {
        const map = this.FindSourceToGeneratedMapping(pathToSource, roots);
        if (map) {
            const mr = map.generatedPositionFor(pathToSource, line, column, bias);
            if (mr && typeof mr.line === "number") {
                return {
                    path: map.generatedPath(),
                    line: mr.line,
                    column: mr.column
                };
            }
        }
        return null;
    }

    public MapToSource(
        pathToGenerated: string,
        line: number,
        column: number,
        roots: string[],
        bias?: Bias
    ): MappingResult {
        const map = this._findGeneratedToSourceMapping(pathToGenerated, roots);
        if (map) {
            const mr = map.originalPositionFor(line, column, bias);
            if (mr && mr.source) {
                return {
                    path: mr.source,
                    content: (<any>mr).content,
                    line: mr.line,
                    column: mr.column
                };
            }
        }
        return null;
    }

    //---- private -----------------------------------------------------------------------

    /**
     * Tries to find a SourceMap for the given source.
     * This is difficult because the source does not contain any information about where
     * the generated code or the source map is located.
     * Our strategy is as follows:
     * - search in all known source maps whether if refers to this source in the sources array.
     * - ...
     */
    public FindSourceToGeneratedMapping(pathToSource: string, roots: string[]): SourceMap {
        if (!pathToSource) {
            return null;
        }

        // try to find in existing
        if (pathToSource in this._sourceToGeneratedMaps) {
            return this._sourceToGeneratedMaps[pathToSource];
        }

        // a reverse lookup: in all source maps try to find pathToSource in the sources array
        for (let key in this._generatedToSourceMaps) {
            const m = this._generatedToSourceMaps[key];
            if (m.doesOriginateFrom(pathToSource)) {
                this._sourceToGeneratedMaps[pathToSource] = m;
                return m;
            }
        }

        // search for all map files in generatedCodeDirectory
        if (this._generatedCodeDirectory) {
            try {
                let maps = FS.readdirSync(this._generatedCodeDirectory).filter(
                    e => Path.extname(e.toLowerCase()) === ".map"
                );
                for (let map_name of maps) {
                    const map_path = Path.join(this._generatedCodeDirectory, map_name);
                    const m = this._loadSourceMap(map_path, roots);
                    if (m && m.doesOriginateFrom(pathToSource)) {
                        //this._log(`FindSourceToGeneratedMapping: found source map for source ${pathToSource} in outDir`);
                        this._sourceToGeneratedMaps[pathToSource] = m;
                        return m;
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        // no map found

        let pathToGenerated = pathToSource;

        const ext = Path.extname(pathToSource);
        if (ext !== ".js") {
            // use heuristic: change extension to ".js" and find a map for it
            const pos = pathToSource.lastIndexOf(".");
            if (pos >= 0) {
                pathToGenerated = pathToSource.substr(0, pos) + ".js";
            }
        }

        let map = null;

        // first look into the generated code directory
        if (this._generatedCodeDirectory) {
            let rest = PathUtils.makeRelative(this._generatedCodeDirectory, pathToGenerated);
            while (rest) {
                const path = Path.join(this._generatedCodeDirectory, rest);
                map = this._findGeneratedToSourceMapping(path, roots);
                if (map) {
                    break;
                }
                rest = PathUtils.removeFirstSegment(rest);
            }
        }

        // VSCode extension host support:
        // we know that the plugin has an "out" directory next to the "src" directory
        if (map === null) {
            let srcSegment = Path.sep + "src" + Path.sep;
            if (pathToGenerated.indexOf(srcSegment) >= 0) {
                let outSegment = Path.sep + "out" + Path.sep;
                pathToGenerated = pathToGenerated.replace(srcSegment, outSegment);
                map = this._findGeneratedToSourceMapping(pathToGenerated, roots);
            }
        }

        // if not found look in the same directory as the source
        if (map === null && pathToGenerated !== pathToSource) {
            map = this._findGeneratedToSourceMapping(pathToGenerated, roots);
        }

        if (map) {
            this._sourceToGeneratedMaps[pathToSource] = map;
            return map;
        }

        // nothing found
        return null;
    }

    /**
     * Tries to find a SourceMap for the given path to a generated file.
     * This is simple if the generated file has the 'sourceMappingURL' at the end.
     * If not, we are using some heuristics...
     */
    private _findGeneratedToSourceMapping(pathToGenerated: string, roots: string[]): SourceMap {
        if (!pathToGenerated) {
            return null;
        }

        if (pathToGenerated in this._generatedToSourceMaps) {
            return this._generatedToSourceMaps[pathToGenerated];
        }

        // First try to load file if there is a ".map" file adjacent to the source
        // file
        const mapPath = pathToGenerated + ".map";
        if (FS.existsSync(mapPath)) {
            const map = this._loadSourceMap(mapPath, roots, pathToGenerated);
            if (map) {
                return map;
            }
        }

        // try to find a source map URL in the generated file
        const uri = this._findSourceMapUrlInFile(pathToGenerated);
        if (!uri) {
            return null;
        }
        // if uri is data url source map is inlined in generated file
        if (uri.indexOf("data:application/json") >= 0) {
            const pos = uri.lastIndexOf(",");
            if (pos > 0) {
                const data = uri.substr(pos + 1);
                try {
                    const buffer = new Buffer(data, "base64");
                    const json = buffer.toString();
                    if (json) {
                        //this._log(`_findGeneratedToSourceMapping: successfully read inlined source map in '${pathToGenerated}'`);
                        return this._registerSourceMap(new SourceMap(pathToGenerated, pathToGenerated, json, roots));
                    }
                } catch (e) {
                    //this._log(`_findGeneratedToSourceMapping: exception while processing data url '${e}'`);
                }
            }
        } else {
            let mapPath = uri;
            // if path is relative make it absolute
            if (!Path.isAbsolute(mapPath)) {
                mapPath = PathUtils.makePathAbsolute(pathToGenerated, mapPath);
            }

            if (FS.existsSync(mapPath)) {
                const map = this._loadSourceMap(mapPath, roots, pathToGenerated);
                if (map) {
                    return map;
                }
            }
        }

        return null;
    }

    /**
     * try to find the 'sourceMappingURL' in the file with the given path.
     * Returns null in case of errors.
     */
    private _findSourceMapUrlInFile(pathToGenerated: string): string {
        try {
            const contents = FS.readFileSync(pathToGenerated).toString();
            const lines = contents.split("\n");
            for (let line of lines) {
                const matches = SourceMaps.SOURCE_MAPPING_MATCHER.exec(line);
                if (matches && matches.length === 2) {
                    const uri = matches[1].trim();
                    //this._log(`_findSourceMapUrlInFile: source map url at end of generated file '${pathToGenerated}''`);
                    return uri;
                }
            }
        } catch (e) {
            // ignore exception
        }
        return null;
    }

    /**
     * Loads source map from file system.
     * If no generatedPath is given, the 'file' attribute of the source map is used.
     */
    private _loadSourceMap(map_path: string, roots: string[], generatedPath?: string): SourceMap {
        if (map_path in this._allSourceMaps) {
            return this._allSourceMaps[map_path];
        }

        try {
            const mp = Path.join(map_path);
            const contents = FS.readFileSync(mp).toString();

            const map = new SourceMap(mp, generatedPath, contents, roots);
            this._allSourceMaps[map_path] = map;

            this._registerSourceMap(map);

            //this._log(`_loadSourceMap: successfully loaded source map '${map_path}'`);

            return map;
        } catch (e) {
            //this._log(`_loadSourceMap: loading source map '${map_path}' failed with exception: ${e}`);
        }
        return null;
    }

    private _registerSourceMap(map: SourceMap): SourceMap {
        const gp = map.generatedPath();
        if (gp) {
            this._generatedToSourceMaps[gp] = map;
        }
        return map;
    }
}

export class SourceMap {
    public _sourcemapLocation: string; // the directory where this sourcemap lives
    public _generatedFile: string; // the generated file to which this source map belongs to
    public _sources: string[]; // the sources of the generated file (relative to sourceRoot)
    public _sourceRoot: string; // the common prefix for the source (can be a URL)
    public _smc: SourceMapConsumer; // the source map
    public _loading: Promise<BasicSourceMapConsumer>;
    private _roots: string[];

    public constructor(mapPath: string, generatedPath: string, json: string, roots: string[]) {
        this._roots = roots;
        this._sourcemapLocation = this.toUrl(Path.dirname(mapPath));

        const sm = JSON.parse(json);

        if (!generatedPath) {
            let file = sm.file;
            if (!PathUtils.isAbsolutePath(file)) {
                generatedPath = PathUtils.makePathAbsolute(mapPath, file);
            }
        }

        this._generatedFile = generatedPath;

        // try to fix all embedded paths because:
        // - source map sources are URLs, so even on Windows they should be using forward slashes.
        // - the source-map library expects forward slashes and their relative path logic
        //   (specifically the "normalize" function) gives incorrect results when passing in backslashes.
        // - paths starting with drive letters are not recognized as absolute by the source-map library

        sm.sourceRoot = this.toUrl(sm.sourceRoot, "");

        for (let i = 0; i < sm.sources.length; i++) {
            sm.sources[i] = this.toUrl(sm.sources[i]);
        }

        this._sourceRoot = sm.sourceRoot;

        // use source-map utilities to normalize sources entries
        this._sources = sm.sources.map(util.normalize).map(source => {
            return this._sourceRoot && util.isAbsolute(this._sourceRoot) && util.isAbsolute(source)
                ? util.relative(this._sourceRoot, source)
                : source;
        });
        try {
            this._loading = new Promise((resolve, reject) => {
                new SourceMapConsumer(sm)
                    .then(smc => {
                        this._smc = smc;
                        resolve(smc);
                    })
                    .catch(e => {
                        reject(e);
                    });
            });
        } catch (e) {
            // ignore exception and leave _smc undefined
            this._loading = Promise.reject(e);
        }
    }

    private toUrl(path: string, dflt?: string): string {
        if (path) {
            path = path.replace(/\\/g, "/");
            path = path.replace(/^webpack\:\/\/\//, "");

            // if path starts with a drive letter convert path to a file:/// url so that the source-map library can handle it
            if (/^[a-zA-Z]\:\//.test(path)) {
                path = "file:///" + path;
            }

            // if path contains upper case drive letter convert to lower case
            if (/^file\:\/\/\/[A-Z]\:\//.test(path)) {
                const dl = path[8];
                path = path.replace(dl, dl.toLowerCase());
            }
            return path;
        }
        return dflt;
    }

    /*
     * The generated file this source map belongs to.
     */
    public generatedPath(): string {
        return this._generatedFile;
    }

    /*
     * Returns true if this source map originates from the given source.
     */
    public doesOriginateFrom(absPath: string): boolean {
        return this.findSource(absPath) !== null;
    }

    /**
     * returns the first entry from the sources array that matches the given absPath
     * or null otherwise.
     */
    public findSource(absPath: string): string {
        // on Windows change back slashes to forward slashes because the source-map library requires this
        if (process.platform === "win32") {
            absPath = absPath.replace(/\\/g, "/");
        }
        for (let name of this._sources) {
            // if (!util.isAbsolute(name)) {
            //     name = util.join(this._sourceRoot, name);
            // }
            let url = this.absolutePath(name);
            if (absPath === url) {
                return name;
            }
        }
        return null;
    }

    /**
     * Tries to make the given path absolute by prefixing it with the source maps location.
     * Any url schemes are removed.
     */
    private absolutePath(path: string): string {
        const prefix = "file://";
        if (!util.isAbsolute(path)) {
            let candidatePath = util.join(this._sourcemapLocation, path);
            if (candidatePath.indexOf(prefix) === 0) {
                candidatePath = candidatePath.substr(prefix.length);
                if (/^\/[a-zA-Z]\:\//.test(candidatePath)) {
                    candidatePath = candidatePath.substr(1);
                }
            }
            if (FS.existsSync(candidatePath)) {
                path = candidatePath;
            } else {
                for (let rpath of this._roots) {
                    const rootPath = Path.join(rpath, path);
                    if (FS.existsSync(rootPath)) {
                        path = rootPath;
                        break;
                    }
                }
            }
        }
        if (path.indexOf(prefix) === 0) {
            path = path.substr(prefix.length);
            if (/^\/[a-zA-Z]\:\//.test(path)) {
                path = path.substr(1);
            }
        }
        // on Windows change forward slashes back to back slashes
        if (process.platform === "win32") {
            // path = path.replace(/\//g, "\\");
            path = path.replace(/\\/g, "/");
        }
        return path;
    }

    /*
     * Finds the nearest source location for the given location in the generated file.
     * Returns null if sourcemap is invalid.
     */
    public originalPositionFor(line: number, column: number, bias: Bias): MappedPosition {
        if (!this._smc) {
            return null;
        }

        const needle = {
            line: line,
            column: column,
            bias: bias || Bias.LEAST_UPPER_BOUND
        };

        const mp = this._smc.originalPositionFor(needle);
        if (mp.source) {
            // if source map has inlined source, return it
            const src = this._smc.sourceContentFor(mp.source);
            if (src) {
                (<any>mp).content = src;
            }

            // map result back to absolute path
            mp.source = this.absolutePath(mp.source);
        }

        return mp;
    }

    /*
     * Finds the nearest location in the generated file for the given source location.
     * Returns null if sourcemap is invalid.
     */
    public generatedPositionFor(absPath: string, line: number, column: number, bias: Bias): Position {
        if (!this._smc) {
            return null;
        }

        // make sure that we use an entry from the "sources" array that matches the passed absolute path
        const source = this.findSource(absPath);
        if (source) {
            const needle = {
                source: source,
                line: line,
                column: column,
                bias: bias || Bias.LEAST_UPPER_BOUND
            };

            return this._smc.generatedPositionFor(needle);
        }

        return null;
    }
}
