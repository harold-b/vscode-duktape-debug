import * as vscode from "vscode";
import { DukDebugSession } from "./DukDebugger";
import * as Net from "net";

/*
 * Set the following compile time flag to true if the
 * debug adapter should run inside the extension host.
 * Please note: the test suite does no longer work in this mode.
 */
const EXTENSION_DEBUG_TYPE = "duk";

export function activate(context: vscode.ExtensionContext) {
    console.log("Duk Debugger Extension Activated");

    if (process.env.NODE_ENV === "development") {
        const factory = new DukDebugAdapterDescriptorFactory();
        context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(EXTENSION_DEBUG_TYPE, factory));
        context.subscriptions.push(factory);
    }
}

export function deactivate() {}

class DukDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    private server?: Net.Server;

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        if (!this.server) {
            // start listening on a random port
            this.server = Net.createServer(socket => {
                const session = new DukDebugSession();
                session.setRunAsServer(true);
                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // make VS Code connect to debug server
        const { port } = this.server.address() as Net.AddressInfo;
        return new vscode.DebugAdapterServer(port);
    }

    dispose() {
        if (this.server) {
            this.server.close();
        }
    }
}
