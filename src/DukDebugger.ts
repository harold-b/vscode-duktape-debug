
import {
    DebugSession, Thread, Source, StackFrame, Scope, Variable, Breakpoint,
    TerminatedEvent, InitializedEvent, StoppedEvent, ContinuedEvent, OutputEvent,
    Handles, ErrorDestination
} from 'vscode-debugadapter';

import {
    DebugProtocol
} from 'vscode-debugprotocol';

import * as Net  from 'net';
import * as Path from 'path';
import * as FS   from 'fs';
import * as util from 'util';
import * as assert from 'assert';
import { ISourceMaps, SourceMaps, SourceMap, Bias } from './sourceMaps';
import * as PathUtils from './pathUtilities';

import * as Promise from "bluebird"     ;

import { DukConnection, DukVersion } from "./DukConnection";

import {
    DukDbgProtocol,
    DukEvent,
    DukStatusState,
    DukScopeMask,

    /// Notifications
    DukStatusNotification,
    DukPrintNotification,
    DukAlertNotification,
    DukLogNotification,
    DukThrowNotification,
    DukAppNotification,

    // Responses
    DukListBreakResponse,
    DukAddBreakResponse,
    DukGetCallStackResponse,
    DukCallStackEntry,
    DukGetLocalsResponse,
    DukEvalResponse,
    DukGetHeapObjInfoResponse,
    DukGetObjPropDescRangeResponse,
    DukGetClosureResponse

} from "./DukDbgProtocol";

//import { DukDbgProtocol as DukDebugProto1_5_0 } from "./v1.5.0/DukDbgProtocol";
//import { DukDbgProtocol as DukDebugProto2_0_0 } from "./v2.0.0/DukDbgProtocol";

import * as Duk from "./DukBase";
import { SourceMapConsumer } from 'source-map';


 // Arguments shared between Launch and Attach requests.
export interface CommonArguments {
    /** comma separated list of trace selectors. Supported:
     * 'all': all
     * 'la': launch/attach
     * 'bp': breakpoints
     * 'sm': source maps
     * */
    trace?: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** Configure source maps. By default source maps are disabled. */
    sourceMaps?: boolean;
    /** Where to look for the generated code. Only used if sourceMaps is true. */
    outDir?: string;
    /** Do show '__artificial' property while inspecting object or not */
    artificial?: boolean;

    // Debug options
    debugLog?: boolean;

    // For musashi-specific builds
    isMusashi?: boolean;
}

type HObjectClassID = number;

// This interface should always match the schema found in the node-debug extension manifest.
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, CommonArguments {
    /** An absolute path to the program to debug. */
    program: string;
    /** Optional arguments passed to the debuggee. */
    args?: string[];
    /** Launch the debuggee in this working directory (specified as an absolute path). If omitted the debuggee is lauched in its own directory. */
    cwd?: string;
    /** Absolute path to the runtime executable to be used. Default is the runtime executable on the PATH. */
    runtimeExecutable?: string;
    /** Optional arguments passed to the runtime executable. */
    runtimeArgs?: string[];
    /** Optional environment variables to pass to the debuggee. The string valued properties of the 'environmentVariables' are used as key/value pairs. */
    env?: { [key: string]: string; };
    /** If true launch the target in an external console. */
    externalConsole?: boolean;
}

// This interface should always match the schema found in the node-debug extension manifest.
export interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments, CommonArguments {
    /** The debug port to attach to. */
    port: number;
    /** The TCP/IP address of the port (remote addresses only supported for node >= 5.0). */
    address?: string;
    /** Retry for this number of milliseconds to connect to the node runtime. */
    timeout?: number;

    /** Node's root directory. */
    remoteRoot?: string;
    /** VS Code's root directory. */
    localRoot?: string;
}

// Utitity
class ArrayX
{
    public static firstOrNull<T>( target:Array<T>, comparer:( value:T ) => boolean ) : T
    {
        for( let i=0; i < target.length; i++ )
            if( comparer( target[i] ) )
                return target[i];

        return null;
    }

    public static convert<T,U>( target:Array<T>, converter:( value:T ) => U ) : Array<U>
    {
        let result = new Array<U>( target.length );
        for( let i=0; i < target.length; i++ )
            result[i] = converter( target[i] );

        return result;
    }
}

enum LaunchType
{
    Launch = 0,
    Attach
}

class DukBreakPoint
{
    public filePath:string;   // Absolute path of the file with the breakpoint
    public dukIdx  :number;   // duktape breakpoint index
    public line    :number;   // Front-end line number

    constructor( filePath:string, line:number )
    {
        this.filePath  = filePath;
        this.line      = line;
    }
}

class BreakPointMap
{
    // Duktape keeps a contiguous breakpoint buffer.
    // Their IDs are based on their position in the buffer,
    // therefore when one breakpoint is removed in the buffer and
    // leaves a hole, all breakpoints following that index will have
    // their id changed implicitly. So we replicated the buffer on the client.
    public _breakpoints:DukBreakPoint[] = [];

    find( filePath:string, line:number ):DukBreakPoint
    {
        return ArrayX.firstOrNull( this._breakpoints, b =>
            b.filePath === filePath && b.line === line
        );
    }

    getBreakpointsForFile( filePath:string ):Array<DukBreakPoint>
    {
        filePath = Path.normalize( filePath );

        let bps                    = this._breakpoints;
        let len                    = bps.length;
        let result:DukBreakPoint[] = [];

        for( let i = 0; i < len; i++ )
        {
            if( bps[i].filePath === filePath )
                result.push( bps[i] );
        }

        return result;
    }

    removeBreakpoints( remList:DukBreakPoint[] ):void
    {
        let bps = this._breakpoints;

        remList.forEach( b => {
            for( let i = 0; i < bps.length; i++ )
            {
                if( bps[i].dukIdx === b.dukIdx ) {
                    bps[i] = null;
                    break;
                }
            }
        });
        for( let i = bps.length-1; i >= 0; i-- )
        {
            if( bps[i] == null )
                bps.splice(i,1);
        }

        // Reset IDs
        for( let i = 0; i < bps.length; i++ )
            bps[i].dukIdx = i;
    }

    addBreakpoints( remList:DukBreakPoint[] ):void
    {
        let bps = this._breakpoints;
        remList.forEach( b => bps.push(b) );

        // Reset IDs
        for( let i = 0; i < bps.length; i++ )
            bps[i].dukIdx = i;
    }
}

class SourceFilePosition
{
    public path     :string;
    public fileName :string;
    public line     :number;
}

// Represents a source file on disk.
// It always points to the generated/output source file, even if sourceMaps are enabled.
class SourceFile
{
    public id         :number;
    public name       :string;
    public path       :string;

    public srcMapPath :string;
    public srcMap     :SourceMap;

    constructor()
    {
    }

    // Generated to original source ( ie: JS -> TS )
    public generated2Source( line:number ):SourceFilePosition
    {
        if( this.srcMap )
        {
            let pos = this.srcMap.originalPositionFor( line, 0, Bias.LEAST_UPPER_BOUND );

            if( pos.line != null )
            {
                return {
                    path     : pos.source,
                    fileName : Path.basename( pos.source ),
                    line     : pos.line
                };
            }
        }

        return {
            path     : this.path,
            fileName : this.name,
            line     : line
        };
    }

    // Original source to generated ( ie: TS -> JS )
    public source2Generated( absSourcePath:string, line:number ):SourceFilePosition
    {
        if( this.srcMap )
        {
            let pos = this.srcMap.generatedPositionFor( absSourcePath, line, 0, Bias.LEAST_UPPER_BOUND );

            if( pos && pos.line != null )
            {
                return {
                    path     : this.path,
                    fileName : this.name,
                    line     : pos.line
                };
            }
        }

        return {
            path     : this.path,
            fileName : this.name,
            line     : line
        };
    }
}

enum PropertySetType
{
    Scope  = 0,
    Object,
    Artificials
}

class PropertySet
{
    public type        :PropertySetType;
    public handle      :number;
    public scope       :DukScope;
    public displayName :string;

    public heapPtr   :Duk.TValPointer;
    public variables :Variable[];

    // Object class type ( for Object set types )
    public classType :HObjectClassID = 0;   // TODO: remove this, deprecated.

    public constructor( type:PropertySetType )
    {
        this.type   = type;
    }
}

class DukScope
{
    public handle     :number;
    public name       :string;
    public stackFrame :DukStackFrame;
    public properties :PropertySet;

    public constructor( name:string, stackFrame:DukStackFrame, properties:PropertySet )
    {
        this.name       = name;
        this.stackFrame = stackFrame;
        this.properties = properties;
    }
}

class DukStackFrame
{
    public handle     :number;
    public source     :SourceFile;

    public fileName   :string;      // We keep a path here, in addition to the SourceFile in
    public filePath   :string;      // case it's a different file than the SourceFile because of SourceMaps

    public funcName   :string;
    public lineNumber :number;
    public pc         :number;
    public depth      :number;
    public klass      :string;
    public scopes     :DukScope[];

    public constructor( source:SourceFile, fileName:string, filePath:string,
                        funcName:string, lineNumber:number, pc:number,
                        depth:number, scopes:DukScope[] )
    {
        this.source     = source     ;
        this.fileName   = fileName   ;
        this.filePath   = filePath   ;
        this.funcName   = funcName   ;
        this.lineNumber = lineNumber ;
        this.pc         = pc         ;
        this.depth      = depth      ;
        this.scopes     = scopes     ;
    }
}

class PtrPropDict {  [key:string]:PropertySet };

class DbgClientState
{
    public paused        :boolean;

    public ptrHandles   :PtrPropDict;            // Access to property sets via pointers
    public varHandles   :Handles<PropertySet>;   // Handles to property sets
    public stackFrames  :Handles<DukStackFrame>;
    public scopes       :Handles<DukScope>;

    public reset() : void
    {
        this.paused         = false;
        this.ptrHandles     = new PtrPropDict();
        this.varHandles     = new Handles<PropertySet>();
        this.stackFrames    = new Handles<DukStackFrame>();
        this.scopes         = new Handles<DukScope>();
    }
}

class ErrorCode
{
    public static RequestFailed = 100;
}

export class DukDebugSession extends DebugSession
{
    private static THREAD_ID = 1;

    private _args           :AttachRequestArguments|LaunchRequestArguments;

    private _nextSourceID   :number         = 1;
    private _sources        :{};                // Key/Value pairs of fileName/SourceFile
    private _sourceMaps     :SourceMaps;        // SourceMap utility
    private _sourceToGen    :{};                // Key/Value pairs of source filePath/SourceFile
                                                // for when SourceMaps are enabled.
                                                // The SourceFile they point to is the SourceFile to
                                                // the generated file. Original sources do not get
                                                // a SourceFile assigned to them.

    // Holds all active breakpoints
    private _breakpoints   :BreakPointMap = new BreakPointMap();

    private _launchType     :LaunchType;
    private _targetProgram  :string;
    private _sourceRoot     :string;
    private _outDir         :string;
    private _stopOnEntry    :boolean;
    private _dukProto       :DukDbgProtocol;

    private _dbgState       :DbgClientState;
    private _initResponse   :DebugProtocol.Response;

    private _processStatus  :boolean;
    private _initialStatus  :DukStatusNotification;

    private _expectingBreak    :string  = "debugger";
    private _expectingContinue :boolean = false;
    private _isDisconnecting   :boolean = false;    // True if the client initiated a disconnect.

    private _scopeMask:DukScopeMask = DukScopeMask.AllButGlobals;

    private _dbgLog:boolean = false;

    //-----------------------------------------------------------
    public constructor()
    {
        super();

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1   ( true );
        this.setDebuggerColumnsStartAt1 ( true );

        this._dbgState    = new DbgClientState();
        this._sources     = {};
        this._sourceToGen = {};
        this._breakpoints._breakpoints = [];
    }

    //-----------------------------------------------------------
    private initDukDbgProtocol( conn:DukConnection, buf:Buffer) : void
    {
        this._dukProto = new DukDbgProtocol( conn, buf, ( msg ) => this.dbgLog(msg) );

        // Status
        this._dukProto.on( DukEvent[DukEvent.nfy_status], ( status:DukStatusNotification ) => {

            if( status.state == DukStatusState.Paused )
                this.dbgLog( "Status Notification: PAUSE" );

            //this.dbgLog( "Status Notification: " +
            //    (status.state == DukStatusState.Paused ? "pause" : "running" ) );

            // If the status cannot be processed right now, store it for later
            if( !this._processStatus )
                this._initialStatus = status;
            else
                this.processStatus( status );
        });

        // Disconnect
        this._dukProto.once( DukEvent[DukEvent.disconnected], ( reason:string) => {
            this.logToClient( `Disconnected: ${ this._isDisconnecting ? "Client disconnected" : reason}\n` );
            this.sendEvent( new TerminatedEvent() );
        });

        // Output
        this._dukProto.on( DukEvent[DukEvent.nfy_print], ( e:DukPrintNotification ) => {
            this.logToClient( e.message, "stdout" );
        });

        this._dukProto.on( DukEvent[DukEvent.nfy_alert], ( e:DukAlertNotification ) => {
            this.logToClient( e.message, "console" );
        });

        this._dukProto.on( DukEvent[DukEvent.nfy_log], ( e:DukLogNotification ) => {
            this.logToClient( e.message, "stdout" );
        });

        // Throw
        this._dukProto.on( DukEvent[DukEvent.nfy_throw], ( e:DukThrowNotification ) => {
            this.logToClient( `Exception thrown @${e.fileName}:${e.lineNumber}: ${e.message}\n`, "stderr" );
            this._expectingBreak = "Exception";

            var sendEvent = function () {
                var source: Source = new Source(e.fileName, Path.resolve(this._outDir, e.fileName));
                var outputEventOptions = {
                    source: source,
                    line: e.lineNumber,
                    column: 1,
                };
                this.logToClient( `Exception thrown: ${e.message}\n`, "stderr", outputEventOptions );
            }.bind(this);

            if (this._sourceMaps) {
                var sourceMap: SourceMap = this._sourceMaps.FindSourceToGeneratedMapping(Path.resolve(this._outDir, e.fileName));
                if (sourceMap && sourceMap._loading) {
                    sourceMap._loading.then(() => {
                        var mappingResult: MappingResult = this._sourceMaps.MapToSource(Path.resolve(this._outDir, e.fileName), e.lineNumber, 0);
                        if (!mappingResult) {
                            sendEvent();
                            return;
                        }
                        var source: Source = new Source(e.fileName, mappingResult.path);
                        var outputEventOptions = {
                            source: source,
                            line: mappingResult.line,
                            column: mappingResult.column,
                        };
                        this.logToClient( `Exception thrown: ${e.message}\n`, "stderr", outputEventOptions );
                    });
                    return;
                }
            }

            sendEvent();
        });

        this._dukProto.on( DukEvent[DukEvent.nfy_appmsg], ( e:DukAppNotification ) => {
            this.logToClient( e.messages.join(' ') + '\n' );
        });
    }

    //-----------------------------------------------------------
    // Begin initialization. Attempt to connect to target
    //-----------------------------------------------------------
    private beginInit( response:DebugProtocol.Response ) : void
    {
        this._initialStatus = null;
        this._processStatus = false;

        // Attached to Debug Server
        let conn:DukConnection;
        let args = <AttachRequestArguments>this._args;

        try {
            const tmOut = args.timeout === undefined ? 10000 : 0;
            conn = DukConnection.connect( args.address, args.port, tmOut );

            conn.once( "connected", ( buf:Buffer, version:DukVersion ) => {

                this.logToClient( "Attached to duktape debugger.\n" );
                conn.removeAllListeners();

                this.logToClient( `Protocol ID: ${version.id}\n` );

                var proto:any;

                if( version.major == 2 || ( version.major == 1 && version.minor >= 5 ) )
                {
                    this.initDukDbgProtocol( conn, buf );
                    this.finalizeInit( response );
                }
                else
                {
                    conn.closeSocket();
                    this.sendErrorResponse( response, 0,
                        `Unsupported duktape version: ${version.dukVersion}` );
                }
            });

            conn.once( "error", ( err ) => {
                this.sendErrorResponse( response, 0, "Attach failed with error: " + err );
            });
        }
        catch(  err ) {
            this.sendErrorResponse( response, 0, "Failed to perform attach with error: " + err );
        }
    }

    //-----------------------------------------------------------
    // Finalize initialization, sned initialized event
    //-----------------------------------------------------------
    private finalizeInit( response:DebugProtocol.Response ) : void
    {
        this.dbgLog( "Finalized Initialization." );

        if( this._args.sourceMaps )
            this._sourceMaps = new SourceMaps( this._outDir );

        this._dbgState.reset();
        this._initResponse          = null;

        // Allow processing of status messages, and if one arrived
        // during initialization, then consider if we have to process it now
        this._processStatus = true;
        const isServerPaused = this._initialStatus && this._initialStatus.state == DukStatusState.Paused;

        // Make sure that any breakpoints that were left set in
        // case of a broken connection are cleared
        this.removeAllTargetBreakpoints().catch( () => {} )
        .then( () => {

            // Set initial paused state depending on the user configuration
            // and any status messages we may have already received from the server
            if( this._args.stopOnEntry )
            {
                // Only request a pause if we haven't got a pause status yet
                if( !isServerPaused )
                    this._dukProto.requestPause();
                else
                    this.processStatus( this._initialStatus );
            }
            else if( isServerPaused )
            {
                this._dukProto.requestResume();
            }
        }).catch( () => {} );

        // Let the front end know we're done initializing
        this.sendResponse( response );
        this.sendEvent( new InitializedEvent() );
    }

    //-----------------------------------------------------------
    // Process incoming status messages
    //-----------------------------------------------------------
    private processStatus( status:DukStatusNotification ) : void
    {
        // Pause/Unpause
        if( status.state == DukStatusState.Paused )
        {
            // Set stopReason to 'breakpoint' if there's a breakpoint in the stop location
            let sourceFile:SourceFile = this.mapSourceFile( status.filename );
            if( sourceFile )
            {
                let line = this.convertDebuggerLineToClient( status.linenumber );
                let pos  = sourceFile.generated2Source( line );

                let bp   = this._breakpoints.find( pos.fileName, pos.line );

                if( bp )
                    this._expectingBreak = "breakpoint";
            }

            this._dbgState.reset();
            this._dbgState.paused = true;
            this.sendEvent( new StoppedEvent( this._expectingBreak, DukDebugSession.THREAD_ID ) );
            this._expectingBreak = "debugger";
        }
        else
        {
            // Resume
            //this._dbgState.reset();

            if( this._dbgState.paused )
            {
                // NOTE: Not doing this because it seems to cause issues.
                // it suddenly continues unexpectedly, even if calling this event
                // in correct synchronized order.
                //this.dbgLog( "Sending CONTINUE event to FE");
                //this.sendEvent( new ContinuedEvent( DukDebugSession.THREAD_ID, true) );
            }

            this._dbgState.paused = false;
        }
    }

    /// DebugSession
    //-----------------------------------------------------------
    // The 'initialize' request is the first request called by the frontend
    // to interrogate the debug adapter about the features it provides.
    //-----------------------------------------------------------
    protected initializeRequest( response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments ): void
    {
        this.dbgLog( "[FE] initializeRequest." );

        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsFunctionBreakpoints      = false;
        response.body.supportsEvaluateForHovers        = true;
        response.body.supportsStepBack                 = false;

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected launchRequest( response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments ) : void
    {
        /// TODO: Support launch
        this.dbgLog( "[FE] launchRequest" );
        this.sendErrorResponse( response, 0, "Launching is not currently supported. Use Attach.");
    }

    //-----------------------------------------------------------
    protected attachRequest( response: DebugProtocol.AttachResponse, args: AttachRequestArguments ) : void
    {
        this.dbgLog( "[FE] attachRequest" );

        if( !args.localRoot || args.localRoot === "" )
        {
            this.sendErrorResponse( response, 0,
                "Must specify a localRoot`" );
            return;
        }

        if( args.sourceMaps && (!args.outDir || args.outDir === "") )
        {
            this.sendErrorResponse( response, 0,
                "Must specify an 'outDir' when 'sourceMaps' is enabled.`" );
            return;
        }

        this._args          = args;
        this._launchType    = LaunchType.Attach;
        this._sourceRoot    = this.normPath( args.localRoot  );
        this._outDir        = this.normPath( args.outDir     );
        this._dbgLog        = args.debugLog || false;

        this.beginInit( response );
    }

    //-----------------------------------------------------------
    protected disconnectRequest( response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments ) : void
    {
        this.dbgLog( "[FE] disconnectRequest" );

        this._isDisconnecting = true;

        if( !this._dukProto.isConnected )
        {
            // Already disconencted
            this.sendResponse( response );
            return;
        }

        const TIMEOUT_MS:number = 2000;

        var doDisconnect = () => {

            clearTimeout( timeoutID );
            this._dukProto.disconnect( "Client disconnected." );

            this.sendResponse( response );
        };

        var timeoutID:NodeJS.Timer = setTimeout( () =>{

            this.dbgLog( "Detach request took too long. Forcefully disconnecting." );
            doDisconnect();

        }, TIMEOUT_MS );

        // Clear all breakpoints & disconnect
        this._breakpoints._breakpoints = [];

        this.dbgLog( "Clearing breakpoints on target." );
        this.removeAllTargetBreakpoints()
        .catch( () => {} )
        .then( () => {

            // At this point the remote socket may have been closed.
            var isConnected = this._dukProto.isConnected;

            ( ( isConnected && this._dukProto.requestDetach()) || Promise.resolve() )
            .catch( () => {} )
            .then( () => doDisconnect() );  // This will be redundant if the detach
                                            // response was received succesfully.
        })
        .catch( () => {} );
    }

    //-----------------------------------------------------------
    protected setBreakPointsRequest( response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments ) : void
    {
        this.dbgLog( "[FE] setBreakPointsRequest" );

        let filePath = Path.normalize( args.source.path );

        let inBreaks:DebugProtocol.SourceBreakpoint[]  = args.breakpoints;  // Breakpoints the file currently has set

        // Determine which breakpoints we're adding and which we are removing
        // by comparing all the source's breakpoints on the breakpoint map with the arg's breakpoints.
        let addBPs:DukBreakPoint[]  = [];
        let remBPs:DukBreakPoint[]  = [];

        let fileBPs:DukBreakPoint[]    = this._breakpoints.getBreakpointsForFile( filePath );
        let addedBPs:DukBreakPoint[] = [];   // List of successfully added breakpoints
        let removedBPs:DukBreakPoint[] = [];   // List of successfully removed breakpoints
        let persistBPs:DukBreakPoint[] = [];

        // Convert the breakpoint lines first
        inBreaks.forEach( b => b.line = this.convertClientLineToDebugger(b.line) );

        // Get breakpoints to add
        inBreaks.forEach( a => {
            if( ArrayX.firstOrNull( fileBPs, b => a.line === b.line ) == null )
                addBPs.push( new DukBreakPoint( filePath, a.line ) );
        });

        // Get breakpoints to remove
        fileBPs.forEach( a => {
            if( ArrayX.firstOrNull( inBreaks, b => a.line === b.line ) == null )
                remBPs.push( a );
        });

        // Get breakpoints that will persist
        fileBPs.forEach( a => {
            if( !ArrayX.firstOrNull( remBPs, b => a.line === b.line ) )
                persistBPs.push( a );
        });

        // Prepare to remove and add breakpoints
        let doRemoveBreakpoints: ( i:number ) => Promise<any>;
        let doAddBreakpoints   : ( i:number ) => Promise<any>;
        let doFindSourceFile   : ( bp:DukBreakPoint ) => Promise<SourceFile>;

        doFindSourceFile = ( bp: DukBreakPoint ) => {
            // Try to find the source file
            let src:SourceFile = this.unmapSourceFile( filePath );

            if( !src )
            {
                let log:string = "Unknown source file: " + filePath;
                this.dbgLog( log );
                this.sendErrorResponse( response, 0, "SetBreakPoint failed" );
                return Promise.reject( log );
            }

            // not sure why this would be null?
            if (!src.srcMap) {
                return Promise.resolve( src );
            }

            return new Promise((resolve, reject) => {
                src.srcMap._loading
                .then( () => resolve( src ) )
                .catch( (e) => reject( e ) )
            })
        }

        doRemoveBreakpoints = ( i:number ) =>
        {
            if( i >= remBPs.length )
                return Promise.resolve();

            let bp           :DukBreakPoint = remBPs[i];

            return this._dukProto.requestRemoveBreakpoint( remBPs[i].dukIdx )
            .then(() => {
                // Immediately update breakpoint map. Indices may change for subsequent requests.
                this._breakpoints.removeBreakpoints( [bp] );

                removedBPs.push(bp);
            })
            .catch( () => {

                console.log('breakpoint faike;');
            } ) // Simply don't add the breakpoint if it failed.
            .then(() => {
                // Remove the next one
                return doRemoveBreakpoints( i+1 );
            });
        };

        doAddBreakpoints = ( i:number ) =>
        {
            if( i >= addBPs.length )
                return Promise.resolve();

            let bp           :DukBreakPoint = addBPs[i];
            let line         :number        = bp.line;
            let generatedName:string        = null;

            return doFindSourceFile( bp )
            .then( src => {

                // Get the correct file and line
                if( src.srcMap )
                {
                    let pos       = src.source2Generated( filePath, line );
                    generatedName = pos.fileName;
                    line = pos.line;
                }
                else
                    generatedName = this.getSourceNameByPath( args.source.path ) || args.source.name;

                if( !generatedName )
                {
                    // Cannot set breakpoint, go to the next one
                    return doAddBreakpoints( i+1 );
                }

                return this._dukProto.requestSetBreakpoint( generatedName, line )
                .then( (r:DukAddBreakResponse) => {
                    // Immediately update breakpoint map. Indices may change for subsequent requests.
                    this._breakpoints.addBreakpoints( [bp] );

                    /// Save the breakpoints to the file source
                    //this.dbgLog( "BRK: " + r.index + " ( " + bp.line + ")");
                    addedBPs.push( bp );
                })
                .catch( () => {} ) // Simply don't add the breakpoint if it failed.
                .then(() => {

                    // Go to the next one
                    return doAddBreakpoints( i+1 );
                });
            })
            .catch( () => {
                console.log('breakpoint faike;');

            } ) // Simply don't add the breakpoint if it failed.
            .then(() => {

                // Go to the next one
                return doAddBreakpoints( i+1 );
            });
        }

        let loadedSourceMap: () => void = () => {
            doRemoveBreakpoints( 0 )
            .then( () => doAddBreakpoints( 0 ) )
            .catch( (e) => {
                console.log(e);
            } )
            .then( () => {

                // Send response
                addedBPs = persistBPs.concat( addedBPs );

                let outBreaks = new Array<Breakpoint>( addedBPs.length );
                for( let i = 0; i < addedBPs.length; i++ )
                    outBreaks[i] = new Breakpoint( true, addedBPs[i].line)

                response.body = { breakpoints: outBreaks };
                this.sendResponse( response );
            });
        }

        // Execute requests
        if (src.srcMap) {
            src.srcMap._loading.then(loadedSourceMap);
        }
        else {
            loadedSourceMap();
        }
    }

    //-----------------------------------------------------------
    protected setFunctionBreakPointsRequest( response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments ): void
    {
        this.dbgLog( "[FE] setFunctionBreakPointsRequest" );
        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected setExceptionBreakPointsRequest( response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments ): void
    {
        this.dbgLog( "[FE] setExceptionBreakPointsRequest" );
        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected configurationDoneRequest( response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments ): void
    {
        this.dbgLog( "[FE] configurationDoneRequest" );
        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected continueRequest( response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments ): void
    {
        this.dbgLog( "[FE] continueRequest" );

        if( this._dbgState.paused )
        {
            this._dukProto.requestResume().then( ( val ) => {

                // A status notification should follow shortly
                //this.sendResponse( response );

            }).catch( (err) => {

                this.requestFailedResponse( response );
            });
            this.sendResponse( response );
        }
        else
        {
            this.dbgLog( "Can't continue when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }
    }

    //-----------------------------------------------------------
    // StepOver
    protected nextRequest( response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments ): void
    {
        this.dbgLog( "[FE] nextRequest" );

        if( !this._dbgState.paused )
        {
            this.dbgLog( "Can't step over when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._expectingBreak = "step";
        this._dukProto.requestStepOver().then( ( val ) => {
            // A status notification should follow shortly
            //this.sendResponse( response );

        }).catch( (err) => {
            //this.requestFailedResponse( response );
        });

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    // StepInto
    protected stepInRequest (response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments ): void
    {
        this.dbgLog( "[FE] stepInRequest" );

        if( !this._dbgState.paused )
        {
            this.dbgLog( "Can't step into when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._expectingBreak = "stepin";
        this._dukProto.requestStepInto().then( ( val ) => {
            // A status notification should follow shortly
            //this.sendResponse( response );

        }).catch( (err) => {
            //this.requestFailedResponse( response );
        });

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    // StepOut
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
    {
        this.dbgLog( "[FE] stepOutRequest" );

        if( !this._dbgState.paused )
        {
            this.dbgLog( "Can't step out when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._expectingBreak = "stepout";
        this._dukProto.requestStepOut().then( ( val ) => {
            // A status notification should follow shortly
            //this.sendResponse( response );

        }).catch( (err) => {
            //this.requestFailedResponse( response );
        });

        // NOTE: This new version seems to cause an error randomly
        // locking the UI if we send the response later on...
        // So we send it immediately and just adopt the Server
        // state when it responds with status messages.
        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected pauseRequest( response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments ): void
    {
        this.dbgLog( "[FE] pauseRequest" );

        if( !this._dbgState.paused )
        {
            this._expectingBreak = "pause";
            this._dukProto.requestPause().then( ( val ) => {

                // A status notification should follow shortly
                //this.sendResponse( response );

            }).catch( (err) => {
                //this.requestFailedResponse( response, "Error pausing." );
            });

            this.sendResponse( response );
        }
        else
        {
            this.dbgLog( "Can't paused when already paused." );
            this.requestFailedResponse( response, "Already paused." );
        }
    }

    //-----------------------------------------------------------
    protected sourceRequest( response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments ): void
    {
        this.dbgLog( "[FE] sourceRequest" );

        let ref = args.sourceReference;

        response.body = { content: "Unknown Source\n" };

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected threadsRequest( response: DebugProtocol.ThreadsResponse ): void
    {
        this.dbgLog( "[FE] threadsRequest" );

        response.body = {
            threads:  [ new Thread( DukDebugSession.THREAD_ID, "Main Thread") ]
        };

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    protected stackTraceRequest( response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments ): void
    {
        this.dbgLog( "[FE] stackTraceRequest" );

        // Make sure we're paused
        if( !this._dbgState.paused )
        {
            this.requestFailedResponse( response,
                "Attempted to obtain stack trace while running." );
            return;
        }

        var getCallStack;
        var dukframes  = new Array<DukStackFrame>();

        var doRespond = () => {

            // Publish Stack Frames
            let frames = [];
            frames.length = dukframes.length;

            for( let i = 0, len=frames.length; i < len; i++ )
            {
                let frame = dukframes[i];

                // Find source file
                let srcFile:SourceFile = frame.source;
                let src    :Source     = null;

                if( srcFile )
                    src = new Source( frame.fileName, frame.filePath, 0 );

                let klsName  = frame.klass    == "" ? "" : frame.klass + ".";
                let funcName = frame.funcName == "" ? "(anonymous function)" : frame.funcName + "()";

                //i: number, nm: string, src: Source, ln: number, col: number
                frames[i] = new StackFrame( frame.handle,
                                klsName + funcName + " : " + frame.pc,
                                src, frame.lineNumber, frame.pc );
            }

            response.body = { stackFrames: frames };
            this.sendResponse( response );
        };

        var doApplyConstructors = ( index:number ) => {

            if( index >= dukframes.length )
            {
                // Finalize response
                doRespond();
                return;
            }

            this.getObjectConstructorByName( "this", dukframes[index].depth )
            .then( ( c:string ) => {
                dukframes[index].klass = c;
                doApplyConstructors( index+1 );
            });

        };

        // Grab callstack from duktape
        this._dukProto.requestCallStack().then( ( val:DukGetCallStackResponse ) => {

            dukframes.length = val.callStack.length;

            for( let i = 0, len=dukframes.length; i < len; i++ )
            {
                let entry = val.callStack[i];

                let srcFile:SourceFile = this.mapSourceFile( entry.fileName );
                let line   :number     = this.convertDebuggerLineToClient( entry.lineNumber );

                // Get correct info to display
                let srcPos:SourceFilePosition = srcFile ?
                    srcFile.generated2Source( line ) :
                    {
                        path     : entry.fileName,
                        fileName : entry.fileName,
                        line     : line
                    };

                // Save stack frame to the state
                let frame = new DukStackFrame( srcFile, srcPos.fileName, srcPos.path,
                                               entry.funcName, srcPos.line, entry.pc,
                                               -i-1, null );

                frame.handle = this._dbgState.stackFrames.create( frame );
                dukframes[i] = frame;
            }

            // Apply constructors to functions
            doApplyConstructors( 0 );

        }).catch( ( err ) => {
            this.dbgLog( "Stack trace failed: " + err );

            response.body = { stackFrames: [] };
            this.sendResponse( response );
            //this.requestFailedResponse( response, "StackTraceRequest failed." );
        });


    }

    //-----------------------------------------------------------
    protected scopesRequest( response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments ):void
    {
        this.dbgLog( "[FE] scopesRequest" );
        assert( this._dbgState.paused );

        if( !this._args.isMusashi )
            this.scopeRequestForLocals( args.frameId, response, args );
        else
            this.scopeRequestForMultiple( args.frameId, response, args );
    }

    //-----------------------------------------------------------
    protected variablesRequest( response:DebugProtocol.VariablesResponse, args:DebugProtocol.VariablesArguments ):void
    {
        this.dbgLog( "[FE] variablesRequest" );
        assert( args.variablesReference != 0 );

        var properties = this._dbgState.varHandles.get( args.variablesReference );

        if( !properties )
        {
            // If a stop event happened, we may have cleared the state.
            response.body = { variables: [] };
            this.sendResponse( response );
            return;

            // TODO: Perhaps handle only one request from the front end at a time,
            // and perhaps cancel any pending if the state changed/cleared
        }

        var scope      = properties.scope;
        var stackFrame = scope.stackFrame;

        var returnVars = ( vars:Variable[] ) => {

            // Sort vars and return them.
            // We don't sort artificial properties
            if( properties.type != PropertySetType.Artificials )
            {
                vars.sort( ( a, b ) => {

                    let aNum  :number  = Number(a.name);
                    let bNum  :number  = Number(b.name);
                    let aIsNum:boolean = !isNaN(aNum);
                    let bIsNum:boolean = !isNaN(bNum);

                    if( !aIsNum && bIsNum )
                        return -1;
                    else if( aIsNum && !bIsNum )
                        return 1;
                    else if( aIsNum && bIsNum )
                    {
                        return aNum < bNum ? -1 :
                               aNum > bNum ? 1 : 0;
                    }

                    if( a.name[0] === "_" ) return -1;
                    if( b.name[0] === "_" ) return 1;

                    if( a.name === "this" ) return -1;
                    if( b.name === "this" ) return 1;

                    return a.name < b.name ? -1 :
                           a.name > b.name ? 1 : 0;
                });
            }

            response.body = { variables: vars };
            this.sendResponse( response );
        };

        // Determine the PropertySet's reference type
        if( properties.type == PropertySetType.Scope )
        {
            // Scope-level variables are resolved at the time of the Scope request
            // just return the variables array
            returnVars( scope.properties.variables );
        }
        else if( properties.type >= PropertySetType.Object )
        {
            // Resolve object sub-properties
            this.expandPropertySubset( properties ).then( objVars => {
                returnVars( objVars );
            });
        }
    }

    //-----------------------------------------------------------
    protected evaluateRequest( response:DebugProtocol.EvaluateResponse, args:DebugProtocol.EvaluateArguments ):void
    {
        this.dbgLog( "[FE] evaluateRequest" );

        let x = args.expression;
        if( x.indexOf( "cmd:") == 0 )
        {
            this.handleCommandLine( response, args );
        }
        else
        {
            let frame = this._dbgState.stackFrames.get( args.frameId );
            if( !frame )
            {
                this.requestFailedResponse( response, "Failed to find stack frame: " + args.frameId );
                return;
            }

            if( !args.expression || args.expression.length < 1 )
            {
                this.requestFailedResponse( response, "Invalid expression" );
                return;
            }

            this.dbgLog( `Expression: ${args.expression}` );

            this._dukProto.requestEval( args.expression, frame.depth )
                .then( resp => {

                    let r = <DukEvalResponse>resp;
                    if( !r.success )
                    {
                        this.requestFailedResponse( response, "Eval failed: " + r.result );
                        return;
                    }
                    else
                    {
                        this.resolveObject(args.expression, r.result, frame.scopes[0]).then(
                            (v) =>
                        {
                            response.body = {
                                result: v.value,
                                variablesReference: v.variablesReference
                            };
                            this.sendResponse( response );
                        })
                    }

                }).catch( err =>{
                    this.requestFailedResponse( response, "Eval request failed: " + err );
                });

            return;
        }

    }

/// Private
    //-----------------------------------------------------------
    // For non-musashi versions, we only support obtaining
    // the local vars as given by duktape.
    //-----------------------------------------------------------
    private scopeRequestForLocals( stackFrameHdl:number, response:DebugProtocol.ScopesResponse, args:DebugProtocol.ScopesArguments ):void
    {
        let stackFrame  = this._dbgState.stackFrames.get( stackFrameHdl );
        let dukScope    = new DukScope( "Local", stackFrame, null );
        dukScope.handle = this._dbgState.scopes.create( dukScope );
        stackFrame.scopes = [ dukScope ];

        var scopes:Scope[] = [];

        this._dukProto.requestLocalVariables( stackFrame.depth )
        .then( ( r:DukGetLocalsResponse ) => {

            // We only care for the names of the local vars
            let keys = ArrayX.convert( r.vars, v => v.name );

            // Append 'this' to local scope, if it's not global
            return this.isGlobalObjectByName( "this", stackFrame.depth )
            .then( (isGlobal:boolean ) => {

                if( !isGlobal )
                    keys.unshift( "this" );

                return this.expandScopeProperties( keys, dukScope )
                .then( (props:PropertySet) => {
                    scopes.push( new Scope( props.scope.name, props.handle, false ) );
                });
            });

        })
        .then( () =>{
            response.body = { scopes: scopes };
            this.sendResponse( response );
        })
        .catch( err => {
            this.dbgLog( "scopesRequest (Locals) failed: " + err );
            response.body = { scopes: [] };
        });
    }

    //-----------------------------------------------------------
    // Musashi-specific mod
    //-----------------------------------------------------------
    private scopeRequestForMultiple( stackFrameHdl:number, response:DebugProtocol.ScopesResponse, args:DebugProtocol.ScopesArguments ):void
    {
        let stackFrame = this._dbgState.stackFrames.get( stackFrameHdl );

        // Prepare DukScope objects
        const names     = [ "Local", "Closure", "Global" ];
        let   dukScopes = new Array<DukScope>( names.length );

        for( let i=0; i < names.length; i++ )
        {
            let scope    = new DukScope( names[i], stackFrame, null );
            scope.handle = this._dbgState.scopes.create( scope );

            dukScopes[i] = scope;
        }
        stackFrame.scopes = dukScopes;

        // Ask Duktape for the scope property keys for this stack frame
        var scopes:Scope[] = [];

        this._dukProto.requestClosures( this._scopeMask, stackFrame.depth )
        .then( ( r:DukGetClosureResponse ) => {

            let keys = [ r.local, r.closure, r.global ];
            let propPromises:Promise<PropertySet>[] = [];

            // Append 'this' to local scope, if it's not global
            return this.isGlobalObjectByName( "this", stackFrame.depth )
            .then( (isGlobal:boolean ) => {

                if( !isGlobal )
                    r.local.unshift( "this" );

                // Create a PropertySet from each scope
                for( let i=0; i < names.length; i++ )
                {
                    if( keys[i].length == 0 )
                        continue;

                    propPromises.push( this.expandScopeProperties( keys[i], dukScopes[i] ) );
                }

                if( propPromises.length > 0 )
                {
                    return Promise.all( propPromises )
                    .then( (results:PropertySet[]) => {

                        for( let i=0; i < results.length; i++ )
                            scopes.push( new Scope( results[i].scope.name,
                                         results[i].handle,
                                         results[i].scope.name == "Global" )
                            );
                    });
                }
            });
        })
        .then( () => {
            response.body = { scopes: scopes };
            this.sendResponse( response );
        })
        .catch( err => {

            this.dbgLog( "scopesRequest failed: " + err );
            response.body = { scopes: [] };
            this.sendResponse( response );
        });
    }

    //-----------------------------------------------------------
    // Parse command-line command
    //-----------------------------------------------------------
    private handleCommandLine( response:DebugProtocol.EvaluateResponse, feArgs:DebugProtocol.EvaluateArguments ):void
    {
        const x = feArgs.expression;

        let args:string[];
        let cmd:string;
        let result:string = "";

        let requireArg = ( i:number ) => {
            if( i < 0 )
                i = args.length-i;

            if( i < 0 || i >= args.length )
            {
                throw new Error( `Required arg at index ${i}` );
                return "";
            }

            return args[i];
        };

        let getBool = ( i:number ) => {
            let arg = requireArg(i);
            let narg = Number(arg);

            if( !isNaN(narg) )
                return narg === 0 ? false : true;

            return Boolean( arg.toLowerCase() );
        };

        args = x.substr( "cmd:".length ).split( " " );
        if( args.length < 1 )
        {
            this.requestFailedResponse( response, "No command" );
            return;
        }

        try {

            cmd = requireArg(0);
            args.shift();

            switch( cmd )
            {
                default :
                    this.requestFailedResponse( response, "Unknown command: " + cmd );
                return;

                case "breakpoints" :
                {
                    this._dukProto.requestListBreakpoints()
                        .then( resp => {

                            let r = <DukListBreakResponse>resp;
                            this.dbgLog( "Breakpoints: " + r.breakpoints.length );
                            for( let i = 0; i < r.breakpoints.length; i++ )
                            {
                                let bp   = r.breakpoints[i];
                                let line = ( "[" + i + "] " + bp.fileName + ": " + bp.line );

                                this.dbgLog( line );
                                result += ( line + "\n" );
                            }

                        }).catch( err => {
                            this.requestFailedResponse( response, "Failed: " + err );
                        });
                }
                break;

                case "scopes_globals" :
                    let enabled = getBool( 0 );
                    this.logToClient( `Scope Mask: ${enabled?'true':'false'}\n` );
                    if( enabled )
                        this._scopeMask |= DukScopeMask.Globals;
                    else
                        this._scopeMask &= (~DukScopeMask.Globals);
                break;
            }
        }
        catch( err ) {

            this.requestFailedResponse( response, `Cmd Failed: ${String(err)}` );
            return;
        }

        response.body = {
            result: result,
            variablesReference: 0
        };

        this.sendResponse( response );
    }

    //-----------------------------------------------------------
    private removeAllTargetBreakpoints() : Promise<any>
    {
        this.dbgLog( "removeAllTargetBreakpoints" );

        var numBreakpoints:number = 0;

        return this._dukProto.requestListBreakpoints()
            .then( (r:DukListBreakResponse) => {

                numBreakpoints = r.breakpoints.length;

                if( numBreakpoints < 1 )
                    return Promise.resolve([]);

                var promises = new Array<Promise<any>>();
                promises.length = numBreakpoints;

                numBreakpoints --; // Make it zero based

                // Duktape's breakpoints are tightly packed and index based,
                // so just remove them each from the top down
                for( let i=numBreakpoints; i >= 0; i-- )
                    promises[i] = this._dukProto.requestRemoveBreakpoint( numBreakpoints-- );

                return Promise.all( promises );
            });
    }

    //-----------------------------------------------------------
    // Obtains all variables for the specificed scope.
    // It creates a PropertySet for that scope and
    // resolves pointers to object types in that scope.
    // It returns a PropertySet with the variables array resolved and
    // ready to be sent to the front end.
    //-----------------------------------------------------------
    private expandScopeProperties( keys:string[], scope:DukScope ) : Promise<PropertySet>
    {
        var propSet = new PropertySet( PropertySetType.Scope );
        propSet.handle    = this._dbgState.varHandles.create( propSet );
        propSet.scope     = scope;
        propSet.variables = [];

        scope.properties = propSet;

        // Eval all the keys to get the values
        let evalPromises = new Array<Promise<any>>( keys.length );

        for( let i=0; i < keys.length; i++ )
            evalPromises[i] = this._dukProto.requestEval( keys[i], scope.stackFrame.depth );

        return Promise.all( evalPromises )
        .then( (results:DukEvalResponse[]) => {

            let ctorPromises:Promise<string>[] = [];    // If we find objects values, get their constructors.
            let objVars     :Variable[]        = [];    // Save object vars separate to set the value
                                                        //  when the constructor promise returns

            // Split into key value pairs, filtering out failed evals
            let pKeys  :string[]          = [];
            let pValues:Duk.DValueUnion[] = [];

            for( let i = 0; i < results.length; i++ )
            {
                if( !results[i].success )
                    continue;

                pKeys.push( keys[i] );
                pValues.push( results[i].result );
            }

            if( pKeys.length < 1 )
                return propSet;

            return this.resolvePropertySetVariables( pKeys, pValues, propSet );
        })
        .catch( err => {
            return propSet;
        });
    }

    //-----------------------------------------------------------
    // Takes a PropertySet that is part of parent object and
    // expands its properties into DebugAdapter Variables2
    //-----------------------------------------------------------
    private expandPropertySubset( propSet:PropertySet ) : Promise<Variable[]>
    {
        if( propSet.type == PropertySetType.Object )
        {
            // Check if this object's properties have been expanded already
            // ( if the variables property is not undefined, it's been expanded )
            if( propSet.variables )
                return Promise.resolve( propSet.variables );

            propSet.variables = [];

            // Inspect the object, this will yield a set of 'artificial properties'
            // which we can use to query the object's 'own' properties
            return this._dukProto.requestInspectHeapObj( propSet.heapPtr )
            .then( ( r:DukGetHeapObjInfoResponse ) => {

                let numArtificial = r.properties.length;
                let props         = r.properties;

                if (this._args.artificial)
                {
                    // Create a property set for the artificials properties
                    let artificials         = new PropertySet( PropertySetType.Artificials );
                    artificials.handle      = this._dbgState.varHandles.create( artificials );
                    artificials.scope       = propSet.scope;

                    // Convert artificials to debugger Variable objets
                    artificials.variables = new Array<Variable>( numArtificial );
                    for( let i=0; i < numArtificial; i++ )
                    {
                        let p = r.properties[i];
                        artificials.variables[i] = new Variable( <string>p.key, String(p.value), 0 );
                    }

                    // Add artificials node to the property set
                    propSet.variables.push( new Variable( "__artificial", "{...}", artificials.handle ) );
                }

                // Get object's 'own' properties
                let maxOwnProps = r.maxPropDescRange;
                if( maxOwnProps < 1 )
                    return propSet.variables;

                return this._dukProto.requestGetObjPropDescRange( propSet.heapPtr, 0, maxOwnProps )
                .then( ( r:DukGetObjPropDescRangeResponse ) => {

                    // Get rid of undefined ones.
                    // ( The array part may return undefined indices )
                    let props:Duk.Property[] = [];
                    for( let i = 0; i < r.properties.length; i++ )
                    {
                        if( r.properties[i].value !== undefined )
                            props.push( r.properties[i] );
                    }

                    // TODO: Need to place internal(I don't mean artificials) properties into their own node.
                    // TODO: Group array indices into sub groups if there's too many?

                    return this.resolvePropertySetVariables(
                        ArrayX.convert( props, (v) => String(v.key) ),
                        ArrayX.convert( props, (v) => v.value),
                        propSet )
                    .then( (p) => propSet.variables );
                });
            });
        }
        else if( propSet.type == PropertySetType.Artificials )
        {
            return Promise.resolve( propSet.variables );
        }

        return Promise.resolve( [] );
    }

    private resolveObject(name: string, value: Duk.TValueUnion, scope: DukScope): Promise<Variable>
    {
        if( value instanceof Duk.TValObject )
        {
            // Check if this object's pointer has already been cached
            let ptrStr     = ((<Duk.TValObject>value).ptr).toString();
            let objPropSet = this._dbgState.ptrHandles[ptrStr];

            if( objPropSet )
            {
                return Promise.resolve(new Variable(name, objPropSet.displayName, objPropSet.handle));
            }
            else
            {
                return new Promise<Variable>(
                    (resolve, reject) =>
                {
                    // This object's properties have not been resolved yet,
                    // resolve it for the first time
                    objPropSet           = new PropertySet( PropertySetType.Object );
                    objPropSet.scope       = scope;
                    objPropSet.heapPtr     = (<Duk.TValObject>value).ptr;
                    objPropSet.classType   = (<Duk.TValObject>value).classID;
                    objPropSet.displayName = "Object";

                    objPropSet.handle           = this._dbgState.varHandles.create( objPropSet );

                    let variable = new Variable(name, objPropSet.displayName, objPropSet.handle);

                    // Register with the pointer map
                    this._dbgState.ptrHandles[ptrStr] = objPropSet;

                    // Try to obtain standard built-in object's dispaly name
                    // by querying the 'class_name' artificial property.
                    this._dukProto.requestInspectHeapObj( objPropSet.heapPtr )
                    .then( (r:DukGetHeapObjInfoResponse) => {

                        var clsName:Duk.Property = ArrayX.firstOrNull( r.properties, v => v.key === "class_name" );

                        if( !clsName || clsName.value === <any>"Object" )
                        {
                            // For plain 'Object' types, we want to try to
                            // obtain its constructor's name.
                            this.getConstructorNameByObject( objPropSet.heapPtr ).then(
                                (className) =>
                                {
                                    variable.value         = className;
                                    resolve(variable);
                                });
                        }
                        else
                        {
                            objPropSet.displayName = <string>clsName.value;
                            variable.value         = objPropSet.displayName;

                            resolve(variable);
                        }
                    });

                });
            }

        }
        else
        {
            // Non-expandable value
            return Promise.resolve(new Variable(name,
                typeof value === "string" ? `"${value}"` : String( value )));
        }
    }

    //-----------------------------------------------------------
    // Takes in a set of keys and dvalues that belong to
    // a specified PropertySet and resolves their values
    // into 'Varaible' objects to be returned to the front end.
    //-----------------------------------------------------------
    private resolvePropertySetVariables( keys:string[], values:Duk.DValueUnion[], propSet:PropertySet ) : Promise<PropertySet>
    {
        let scope     :DukScope = propSet.scope;
        let stackDepth:number   = scope.stackFrame.depth;

        let objClassPromises:Promise<any>[] = [];   // For resolving the object's "class_name" artificial prop.
        let toStrPromises   :Promise<any>[] = [];   // If we find regular object values, get their toString value
        let objVars         :Variable[]     = [];   // Save object vars separately to set the value
                                                    //  when the toString promises return
        if( !propSet.variables )
            propSet.variables = [];

        // Get all the variables ready
        for( let i = 0; i < keys.length; i++ )
        {
            let key   = keys[i];
            let value = values[i];

            let variable = new Variable( key, "", 0 );
            propSet.variables.push( variable );

            // If it's an object, create a sub property set
            if( value instanceof Duk.TValObject )
            {
                // Check if this object's pointer has already been cached
                let ptrStr     = ((<Duk.TValObject>value).ptr).toString();
                let objPropSet = this._dbgState.ptrHandles[ptrStr];

                if( objPropSet )
                {
                    // Object already exists, refer to prop set handle
                    variable.variablesReference = objPropSet.handle;

                    // NOTE: Existing prop sets might register themselves to
                    // get the display name as well if the existing object
                    // was registered on this very call
                    // (that existing variable is in the same object level as this one),
                    // then it's 'displayName' field currently points to undefined.
                    if( objPropSet.displayName )
                    {
                        variable.value = objPropSet.displayName;
                        continue;
                    }
                }
                else
                {
                    // This object's properties have not been resolved yet,
                    // resolve it for the first time
                    objPropSet           = new PropertySet( PropertySetType.Object );
                    objPropSet.scope       = scope;
                    objPropSet.heapPtr     = (<Duk.TValObject>value).ptr;
                    objPropSet.classType   = (<Duk.TValObject>value).classID;
                    objPropSet.displayName = "Object";
                    variable.value = objPropSet.displayName;

                    objPropSet.handle           = this._dbgState.varHandles.create( objPropSet );
                    variable.variablesReference = objPropSet.handle;

                    // Register with the pointer map
                    this._dbgState.ptrHandles[ptrStr] = objPropSet;

                    // Try to obtain standard built-in object's dispaly name
                    // by querying the 'class_name' artificial property.
                    var objPromise = this._dukProto.requestInspectHeapObj( objPropSet.heapPtr )
                    .then( (r:DukGetHeapObjInfoResponse) => {

                        var clsName:Duk.Property = ArrayX.firstOrNull( r.properties, v => v.key === "class_name" );

                        if( !clsName || clsName.value === <any>"Object" )
                        {
                            // For plain 'Object' types, we want to try to
                            // obtain its constructor's name.
                            toStrPromises.push( this.getConstructorNameByObject( objPropSet.heapPtr ) );
                            objVars.push( variable );
                        }
                        else
                        {
                            objPropSet.displayName = <string>clsName.value;
                            variable.value         = objPropSet.displayName;
                        }
                    });

                    objClassPromises.push( objPromise );
                }

                // Eval Object.toString()
                //let expr = `${key}.toString()`;
                //toStrPromises.push( this._dukProto.requestEval( expr, stackDepth ) );
                // NOTE: We are not doing toString anymore, for the time
                // being we just get the constructor name. This is because
                // there's no way to call 'toString' by object/ptr value. Only
                // by property lookup + eval. We can do that, as we did in the
                // first implementation, but it would be pretty slow for long property
                // chains (deeply nested objects). Maybe we'll do so later, but for now
                // the constructor name is enough.
            }
            else
            {
                // Non-expandable value
                variable.value = typeof value === "string" ? `"${value}"` : String( value );
            }
        }

        return Promise.all( objClassPromises )
        .then( () => {

            // Set the object var's display value to the 'toString' result
            return Promise.all( toStrPromises )
            .then( (toStrResults:string[]) => {

                // For objects whose 'toString' resolved to '[object Object]'
                // we attempt to get a more suitable name by callng it's
                // constructor.name property to see if it yields anything useful
                let ctorRequests:Array<Promise<DukEvalResponse>> = [];
                let ctorVars    :Array<Variable> = [];

                for( let i=0; i < toStrResults.length; i++ )
                {
                    let rName:string = toStrResults[i];
                    /*
                    //let r = toStrResults[i];

                    rName = r.success ? String(r.result) : "Object";

                    if( rName.indexOf("[object") >= 0 )
                    {
                        if( rName === "[object Object]" )
                        {
                            let exp = `String(${objVars[i].name}.constructor.name)`;

                            ctorRequests.push( this._dukProto.requestEval( exp) );
                            ctorVars.push( objVars[i] );
                        }
                        else
                        {
                            rName = rName.substring( "[object ".length, rName.length-1 );
                        }
                    }
                    */
                    this._dbgState.varHandles.get( objVars[i].variablesReference ).displayName = rName;
                    objVars[i].value = rName;
                }

                // If we have any that resolved to '[object Object]', then attempt
                // to get it's constructor's name
                if( ctorRequests.length > 0 )
                {
                    return Promise.all( ctorRequests )
                    .then( (ctorNameResp:DukEvalResponse[]) => {

                        // Use the constructor obtained
                        for( let i = 0; i < ctorNameResp.length; i++ )
                        {
                            if( ctorNameResp[i].success )
                                ctorVars[i].value = <string>ctorNameResp[i].result;
                        }

                        return Promise.resolve( propSet );
                    });
                }

                return Promise.resolve( propSet );
            });
        })
        .catch( () => {} )
        .then( () => {
            return Promise.resolve( propSet );
         });
    }

    //-----------------------------------------------------------
    // Returns the object constructor. If it's the global object,
    // or an error occurrs, then it return an empty string.
    //-----------------------------------------------------------
    private getObjectConstructorByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "(" + prefix + '.constructor.toString().match(/\\w+/g)[1])';

        return this.isGlobalObjectByName( prefix, stackDepth )
        .then( isGlobal => {

            if( isGlobal )
                return  "";

            // Not global object, try to get the constructor name
            return this._dukProto.requestEval( exp, stackDepth )
            .then( resp => {
                let r = <DukEvalResponse>resp;
                return r.success ? String(r.result) : "";
            });

        }).catch( err => "" );
    }

    //-----------------------------------------------------------
    // Get constructor name by object ref
    //-----------------------------------------------------------
    private getConstructorNameByObject( ptr:Duk.TValPointer ): Promise<string>
    {
        // First get the artificials from the object,
        // then find the prototype object from the artificials list,
        // then get it's artificials to find the entry part's max value,
        // then get the constructor and then find its name property

        let protoPtr:Duk.TValPointer;

        return this._dukProto.requestInspectHeapObj( ptr )
        .then( (r:DukGetHeapObjInfoResponse) => {

            let p:Duk.Property = ArrayX.firstOrNull( r.properties, n => n.key === "prototype" );
            protoPtr = (<Duk.TValObject>p.value).ptr;

            return this._dukProto.requestInspectHeapObj( protoPtr );
        })
        .then( (r:DukGetHeapObjInfoResponse) => {

            return this._dukProto.requestGetObjPropDescRange( protoPtr, 0, r.maxPropEntriesRange );
        })
        .then( (r:DukGetObjPropDescRangeResponse) => {

            let p:Duk.Property = ArrayX.firstOrNull( r.properties, n => n.key === "constructor" );
            let obj = <Duk.TValObject>p.value;

            return this._dukProto.requestGetObjPropDescRange( (<Duk.TValObject>p.value).ptr, 0, 0x7fffffff );
        })
        .then( (r:DukGetObjPropDescRangeResponse) => {

            let p:Duk.Property = ArrayX.firstOrNull( r.properties, n => n.key === "name" );
            return <string>p.value;
        })
        .catch( ( err ) => {
            let errStr = String( err );
            this.dbgLog( errStr );
            return "Object";
        });
    }

    //-----------------------------------------------------------
    // Returns true if the target prefix evaluates to the global
    // object. It rejects upon failure.
    //-----------------------------------------------------------
    private isGlobalObjectByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "String(" + prefix + ")";

        return this._dukProto.requestEval( exp, stackDepth )
        .then(
             (resp) => {

                let r = <DukEvalResponse>resp;
                if( !r.success )
                    return Promise.reject( "failed" );
                else
                {
                    let isglob = <string>r.result === "[object global]" ? true : false;
                    return Promise.resolve( isglob );
                }
            },

            ( err ) => { Promise.reject( err ) }
        );
    }

    //-----------------------------------------------------------
    private mapSourceFile( name:string ) : SourceFile
    {
        if( !name )
            return null;

        name = this.normPath( name );

        let sources = this._sources;

        // Attempt to find it first
        for( let k in sources )
        {
            let val:SourceFile = sources[k];
            if( val.name == name )
                return val;
        }

        let fpath;
        if( this._args.sourceMaps )
            fpath = this.normPath( Path.join( this._outDir, name ) );
        else
            fpath = this.normPath( Path.join( this._sourceRoot, name ) );

        if( !FS.existsSync( fpath ) )
            return null;

        let src:SourceFile = new SourceFile();
        src.id   = this._nextSourceID ++;
        src.name = name;
        src.path = fpath;

        sources[src.id]   = src;
        sources[src.name] = src;

        // Grab the source map, if it has any
        try {
            this.checkForSourceMap( src );
            if( src.srcMap )
            {
                // Create a generated-to-oiriginal lookup
                // entry for each file in the source map.
                let srcMap = src.srcMap;
                for( let i = 0; i < srcMap._sources.length; i++ )
                {
                    let srcPath = srcMap._sources[i];
                    if( !Path.isAbsolute( srcPath ) )
                    {
                        // According to https://sourcemaps.info/spec.html#h.75yo6yoyk7x5 :
                        // if the sources are not absolute URLs after prepending of the “sourceRoot”, the sources are resolved relative to the SourceMap
                        srcPath = Path.resolve(Path.dirname(this.normPath(Path.join(this._outDir, name))), srcPath);
                    }

                    srcPath = Path.normalize( srcPath );
                    this._sourceToGen[srcPath] = src;
                }
            }

        } catch( err ){}


        return src;
    }

    //-----------------------------------------------------------
    // Given the original source file name, this looks for a
    // src-to-gen mapped SourceFile that has that name.
    // If it doesn't find one, it looks into
    // the source maps of all the generated files
    // and attempts to find the file in them
    //-----------------------------------------------------------
    private unmapSourceFile( path:string ):SourceFile
    {
        path        = Path.normalize( path );
        let name    = Path.basename( path );

        // Grab the relative path under the source root if this is located there,
        // or just keep the full path if it's not
        let pathUnderRoot = Path.dirname( this.getSourceNameByPath( path ) || "" );

        if( !this._sourceMaps )
            return this.mapSourceFile( Path.join( pathUnderRoot, name ) );

        let src2gen = this._sourceToGen;

        // Attempt a reverse lookup first
        if( src2gen[path] )
            return src2gen[path];

        let src:SourceFile = null;

        // If we still haven't found anything,
        // we try to mapa the source files in the outDir until
        // we find the matching one.
        const scanDir = ( dirPath:string, rootPath:string ) => {

            // In case the directory doesn't exsist
            var files:string[];
            try { files = FS.readdirSync( dirPath ); }
            catch ( err ) {
                return;
            }

            // Ignore non-js files
            files = files.filter( f => Path.extname( f ).toLocaleLowerCase() === ".js" );

            for( let i = 0; i < files.length; i++ )
            {
                let f:string = files[i];

                var stat = FS.lstatSync( Path.join( dirPath, f ) );
                if( stat.isDirectory() )        // Ignore dirs, shallow search
                    continue;

                var candidate = this.mapSourceFile( Path.join( rootPath, f ) );
                if (candidate.name == name)
                    return candidate;
                if (!candidate.srcMap)
                    return;
                for (var candidateFile of candidate.srcMap._sources) {
                    if (candidateFile && Path.resolve(this._outDir, candidateFile) == path)
                        return candidate;
                }
            }
        };


        // Let's construct the folder to scan by combining the path
        // coming in with the out directory. The path coming in may
        // point to a subfolder under "rootPath"
        // so this will ensure that we are looking in the right directory
        let outDirToScan = Path.join( this._outDir, pathUnderRoot );

        // For transpiled sourcess that have been concatenated into a single file,
        // the output folder here may not exsist, since the output is a single file.
        // Therefore no such other directory or file mathching the source folder structure
        // may exsist in the output directory.  So we first attempt to scan the path matching
        // the source root structure, then a flat scan of the outDir.
        return scanDir( outDirToScan, pathUnderRoot ) || scanDir( this._outDir, "" );
    }

    //-----------------------------------------------------------
    private checkForSourceMap( src:SourceFile )
    {
        if( !this._args.sourceMaps )
            return;

        src.srcMap     = this._sourceMaps.MapPathFromSource( src.path );
        src.srcMapPath = src.srcMap.generatedPath();
    }

    //-----------------------------------------------------------
    private getSourceNameByPath( fpath:string ) : string
    {
        fpath = this.normPath( fpath );

        if( fpath.indexOf( this._sourceRoot ) != 0 )
            return undefined;

        return fpath.substr( this._sourceRoot.length+1 );
    }

    //-----------------------------------------------------------
    private requestFailedResponse( response:DebugProtocol.Response, msg?:any ) : void
    {
        msg = msg ? msg.toString() : "";

        msg = "Request failed: " + msg;
        this.dbgLog( "ERROR: " + msg );
        this.sendErrorResponse( response, ErrorCode.RequestFailed, msg );
    }

    //-----------------------------------------------------------
    private normPath( fpath:string ) : string
    {
        if( !fpath )
            fpath = "";

        fpath = Path.normalize( fpath );
        fpath = fpath.replace(/\\/g, '/');
        return fpath;
    }

    //-----------------------------------------------------------
    private logToClient( msg:string, category?:string ) : void
    {
        this.sendEvent( new OutputEvent( msg, category ) );
        console.log( msg );
    }

    //-----------------------------------------------------------
    private dbgLog( msg:string ) : void
    {
        if( this._dbgLog && msg && msg.length > 0 )
        {
            // Workaround for #11: https://github.com/harold-b/vscode-duktape-debug/issues/11
            var buf = new Buffer( msg );
                for( var i=0, len=buf.length; i < len; i++ )
                    if( buf[i] > 0x7F )
                        buf[i] = 0x3F;

            msg = buf.toString( 'utf8' );

            this.sendEvent( new OutputEvent( msg + "\n" ) );
            console.log( msg );
        }
    }
}

DebugSession.run( DukDebugSession );
