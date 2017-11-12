
import * as vscode from "vscode";
import * as Path   from "path";

const initialConfigurations = [
	{
		name        : "Attach",
		type        : "duk",
		request     : "attach",

		address     : "localhost",
		port        : 9091,
		localRoot   : "${workspaceRoot}",
		sourceMaps  : false,
		outDir      : null,
		stopOnEntry : false,
		artificial  : true,
		debugLog    : false
	}
];

export function activate( context:vscode.ExtensionContext )
{
	console.log( "Duk Ext Activated" );

	const vscmds = vscode.commands;
	const subs   = context.subscriptions;
	
	var extCmds = {
		"duk-debug.provideInitialConfigurations": () => provideInitialConfigurations()
	};

	for( var k in extCmds )
	{
		var cmd = extCmds[k];
		subs.push( vscmds.registerCommand( k, cmd ) );
	}
}

export function deactivate() {
}


function provideInitialConfigurations():string
{
	var cfgs = JSON.stringify( initialConfigurations, null, '\t' )
				.split( "\n" ).map( l => '\t' + l ).join( '\n' ).trim();

	return [
		"{",
		'\t"version": "0.2.0",',
        '\t"configurations": ' + cfgs,
		"}"
	].join( "\n");
}
