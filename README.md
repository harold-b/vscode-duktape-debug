# VSCode Debugger for Duktape

[Duktape](https://github.com/svaarala/duktape) debug client for Visual Studio Code.

![Screenshot](https://raw.githubusercontent.com/harold-b/vscode-duktape-debug/master/img/musa-debug.gif)

## Features
 - Local scope inspection (Duktape only provides local scope).
 - "this" object binding inspection.
 - Deep object inspection (nested objects).
 - Source map support. \**inlined currently unsupported*\*
 - Console input evals.
 - Artificial property inspection.
 
## Status
It works. I'd like to refactor it and polish it more as I find the time.

## Usage
Create a new launch configuration and configure the address and port to your debug server's address and port.

## Example
``` JSON
"configurations": [
        {
            "name"        : "Duk Attach",
            "type"        : "duk",
            "request"     : "attach",
            "stopOnEntry" : false,
            
            "address"     : "localhost",
            "port"        : 9091,
            
            "localRoot"   : "${workspaceRoot}",
            
            "sourceMaps"  : true,
            "outDir"      : "${workspaceRoot}/bin"
        }
```

## Debug Options
Use `debugLog` to enable network traffic logging.

## References
 - [https://code.visualstudio.com/docs/extensions/overview](https://code.visualstudio.com/docs/extensions/overview)
 - [https://code.visualstudio.com/docs/extensions/example-debuggers](https://code.visualstudio.com/docs/extensions/example-debuggers)

The adapter uses the debugger protocol based on Duktape version 1.5.0 of [debugger.rst](https://github.com/svaarala/duktape/blob/v1.5.0/doc/debugger.rst).



## Acknoledgements
Special thanks to Sami Vaarala for developing Duktape, and for freely sharing it with the community.
A "thank you" also to the VSCode team for facilitating their open-source IDE and the ability to easily make extensions for it.

This code contains portions borrowed or adapted from the [vscode nodeJS debugger](https://github.com/Microsoft/vscode-node-debug) and Sami Vaarala's web-based nodeJS [reference implementation](https://github.com/svaarala/duktape/tree/master/debugger) of a Dukatape debug client.

## License
[MIT](https://github.com/harold-b/vscode-duktape-debug/blob/master/LICENSE.txt)

(c) Harold Brenes 2016

**Ἐμοὶ γὰρ, τὸ ζῆν Χριστὸς, καὶ τὸ ἀποθανεῖν, κέρδος.**