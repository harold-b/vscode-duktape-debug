# VSCode Debugger for Duktape

A [Duktape](https://github.com/svaarala/duktape) debug client for Visual Studio Code.

**Developed for version `1.5.*` of the Duktape runtime. See [References](#References) below for more information.**

![Screenshot](https://raw.githubusercontent.com/harold-b/vscode-duktape-debug/master/img/screenshot.gif)

## Features
 - Local scope inspection (Duktape only provides local scope).
 - "this" object binding inspection.
 - Deep object inspection (nested objects).
 - Source map support. \**inlined currently unsupported*\*
 - Console input evals.
 - Artificial property inspection.
 
</br>

## Status
It works. I'd like to refactor it and polish it more as I find the time.

</br>

## Usage
Create a new launch.json configuration file and configure the address and port to your debug server's listening address and port.

### Example
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

### Debug Options

If you'd like to see the network traffic exchanged between the client and server, set the following option in your launch.json configuration:
``` JSON
"debugLog" : true
```

</br>

## Debug Host (Server) Instructions
For the debugger client to work with your Duktape host application, you must enable the following preprocessor macros:

``` C
// Required to enable debugger support:
#define DUK_USE_DEBUGGER_SUPPORT
#define DUK_USE_INTERRUPT_COUNTER

// To enable heap object inspection:
// Note: If this option is not enabled, you will only
//  be able to inspect local variables in the call stack.
//  No object properties will be inspectble.
#define DUK_USE_DEBUGGER_INSPECT

// (Optional) To forward log calls to the client:
#define DUK_USE_DEBUGGER_FWD_LOGGING
#define DUK_USE_DEBUGGER_FWD_PRINTALERT

// (Optional) To notify the client when an error is about to be thrown:
#define DUK_USE_DEBUGGER_THROW_NOTIFY

// (Optional) To pause on an uncaught errors:
#define DUK_USE_DEBUGGER_PAUSE_UNCAUGHT


// The following option to enable the 'DumpHeap' command is currently unsupported.
#define DUK_USE_DEBUGGER_DUMPHEAP
```
For more information about the aforementioned options, see [this entry](http://wiki.duktape.org/ConfigOptions.html) on the Duktape wiki.

You must also have a transport layer written in your Duktape host application to enable debugging via [duk_debugger_attach()](http://duktape.org/api.html#duk_debugger_attach) or [.duk_debugger_attach_custom()](http://duktape.org/api.html#duk_debugger_attach_custom) . You may use Duktape's [reference implementation](https://github.com/svaarala/duktape/tree/master/examples/debug-trans-socket).

For an example of an application with debugger support, please see [Duktape's command line app](https://github.com/svaarala/duktape/tree/master/examples/cmdline).

</br>

## References
 - [https://code.visualstudio.com/docs/extensions/overview](https://code.visualstudio.com/docs/extensions/overview)
 - [https://code.visualstudio.com/docs/extensions/example-debuggers](https://code.visualstudio.com/docs/extensions/example-debuggers)

The adapter uses the debugger protocol based on Duktape version 1.5.0 of [debugger.rst](https://github.com/svaarala/duktape/blob/v1.5.0/doc/debugger.rst).

</br>

## Acknoledgements
Special thanks to Sami Vaarala for developing Duktape, and for freely sharing it with the community.
A "thank you" also to the VSCode team for facilitating their open-source IDE and the ability to easily make extensions for it.

This code contains portions borrowed or adapted from the [vscode nodeJS debugger](https://github.com/Microsoft/vscode-node-debug) and Sami Vaarala's web-based nodeJS [reference implementation](https://github.com/svaarala/duktape/tree/master/debugger) of a Dukatape debug client.

</br>

## License
[MIT](https://github.com/harold-b/vscode-duktape-debug/blob/master/LICENSE.txt)

(c) Harold Brenes 2016-2017

**Ἐμοὶ γὰρ, τὸ ζῆν Χριστὸς, καὶ τὸ ἀποθανεῖν, κέρδος.**