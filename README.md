# VSCode Duktape Debug Adapter

## Greetings
Peace be with you in the name of our Lord Yeshua the Messiah.

## Description
A debug adapter for Visual Studio Code written in Typescript targeting [Duktape](https://github.com/svaarala/duktape) runtimes. It implements the VS Code Debug Protocol (or CDP),

See: 
 - [https://code.visualstudio.com/docs/extensions/overview](https://code.visualstudio.com/docs/extensions/overview)
 - [https://code.visualstudio.com/docs/extensions/example-debuggers](https://code.visualstudio.com/docs/extensions/example-debuggers)

This code contains portions borrowed or adapted from the [vscode nodeJS debugger](https://github.com/Microsoft/vscode-node-debug) and Sami Vaarala's web-based nodeJS [reference implementation](https://github.com/svaarala/duktape/tree/master/debugger) of a Dukatape debug client.

## Status
**Pending upload of initial repository.** It currently supports the full protocol as described in version 1.40 of [debugger.rst](https://github.com/svaarala/duktape/blob/master/doc/debugger.rst). The client-sdde features include deep object inspection (nested objects). "this" object binding inspection for the current closure (suppressed when set to global).
