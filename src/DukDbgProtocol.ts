/// Transport layer for the Duktape debug protocol.
/// (c) Harold Brenes 2016
///
/// Some code adapted from Saami Vaarala's duk_debug.js :
/// See: https://github.com/svaarala/duktape/blob/master/doc/debugger.rst
///      https://github.com/svaarala/duktape/blob/master/debugger/duk_debug.js


import * as Net    from "net"         ;
import * as EE     from "events"      ;
import * as assert from "assert"      ;
import * as Duk    from "./DukConsts" ;
import * as os     from "os"          ;

const MSG_TRACING      :boolean = true;
const LOG_STATUS_NOTIFY:boolean = false;

export const enum DukStatusState
{
    Running = 0x00,
    Paused  = 0x01
}

export const enum DukThrowFatal
{
    Caught = 0x00,
    Fatal  = 0x01
}

export const enum DukDetachReason
{
    Normal      = 0x00,
    StreamError = 0x01
}

export enum DukEndianness
{
    Little = 1,
    Mixed  = 2,
    Big    = 3
}

export const enum DukScopeMask
{
    None     = 0x00,
    Locals   = 0x01,
    Closures = 0x02,
    Globals  = 0x04,

    All           = Locals | Closures | Globals,
    AllButGlobals = Locals | Closures
}

export class DukDvalueMsg extends Array<Duk.DValue> {}

export class DukProtoMessage
{
    public msgtype:number;

    constructor( type:number )
    {
        this.msgtype = type;
    }
}

/// Notifications
export class DukNotificationMessage extends DukProtoMessage
{
    public cmd:Duk.NotifyType;

    constructor( cmd:number )
    {
        super( Duk.MsgType.NFY );
        this.cmd = cmd;
    }
}

export class DukStatusNotification extends DukNotificationMessage
{
    public state      :DukStatusState;
    public filename   :string;
    public funcname   :string;
    public linenumber :number;
    public pc         :number;

    constructor( msg:DukDvalueMsg )
    {
        assert( msg.length == 8 );
        super( Duk.NotifyType.STATUS );

        this.state      = <DukStatusState>msg[2].value;
        this.filename   = <string>msg[3].value;
        this.funcname   = <string>msg[4].value;
        this.linenumber = <number>msg[5].value;
        this.pc         = <number>msg[6].value;
    }
}

export class DukPrintNotification extends DukNotificationMessage
{
    public message:string;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.NotifyType.PRINT );
        this.message = <string>msg[2].value;
    }
}

export class DukAlertNotification extends DukNotificationMessage
{
    public message:string;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.NotifyType.ALERT );
        this.message = <string>msg[2].value;
    }
}

export class DukLogNotification extends DukNotificationMessage
{
    public level   :number;
    public message :string;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.NotifyType.LOG );
        this.level   = <number>msg[2].value;
        this.message = <string>msg[3].value;
    }
}

export class DukThrowNotification extends DukNotificationMessage
{
    // NFY <int: 5> <int: fatal> <str: msg> <str: filename> <int: linenumber> EOM
    public fatal      :DukThrowFatal;
    public message    :string;
    public fileName   :string;
    public lineNumber :number;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.NotifyType.THROW );

        if( msg.length != 7 )
            throw new Error( "Invalid notification message." );

        this.fatal      = <DukThrowFatal><number>msg[2].value;
        this.message    = <string>msg[3].value;
        this.fileName   = <string>msg[4].value;
        this.lineNumber = <number>msg[5].value;
    }
}

export class DukDetachingNotification extends DukNotificationMessage
{
    public reason     :DukDetachReason;
    public message    :string;
}

/// Requests
export class DukRequest extends DukProtoMessage
{
    public cmd      :Duk.CmdType;
    public sequence :number;

    constructor( cmd:number, sequence:number )
    {
        super( Duk.MsgType.REQ );

        this.cmd      = cmd;
        this.sequence = sequence;
    }
}

/// Responses
export class DukResponse extends DukProtoMessage
{
    public cmd :number;

    constructor( cmd:number )
    {
        super( Duk.MsgType.REP );

        this.cmd = cmd;
    }
}

export class DukBasicInfoResponse extends DukResponse
{
    // REP <int: DUK_VERSION> <str: DUK_GIT_DESCRIBE> <str: target info> 
    //     <int: endianness> <int: sizeof(void *)> EOM
    public version    :number;
    public gitDesc    :string;
    public targetInfo :string;
    public endianness :DukEndianness;
    public ptrSize    :number;
    
    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.BASICINFO );
        
        if( msg.length != 7 )
            throw new Error( "Invalid 'BasicInfo' response message." );
        
        this.version    = <number>msg[1].value;
        this.gitDesc    = <string>msg[2].value;
        this.targetInfo = <string>msg[3].value;
        this.endianness = <DukEndianness>msg[4].value;
        this.ptrSize    = <number>msg[5].value;
        
        if( this.endianness < DukEndianness.Little ||
            this.endianness > DukEndianness.Big )
                throw new Error( "Invalid endianness" );
    }
}

export class DukAddBreakResponse extends DukResponse
{
    public index:number;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.ADDBREAK );

        assert( msg.length == 3 );
        if( msg[1].type !== Duk.DValKind.int ) throw new TypeError( );

        this.index = <number>msg[1].value;
    }
}

export class DukCallStackEntry
{
     // [ <str: fileName> <str: funcName> <int: lineNumber> <int: pc> ]
     public fileName   :string;
     public funcName   :string;
     public lineNumber :number;
     public pc         :number;

     public constructor( fileName:string, funcName:string,
                         lineNumber:number, pc:number )
     {
        this.fileName   = fileName   ;
        this.funcName   = funcName   ;
        this.lineNumber = lineNumber ;
        this.pc         = pc         ;
     }
}

export class DukGetCallStackResponse extends DukResponse
{
    public callStack:DukCallStackEntry[];

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.GETCALLSTACK );

        let len = ( msg.length - 2 );
        if( len == 0 )
        {
            this.callStack = new DukCallStackEntry[0];
        }
        else
        {
            assert( len % 4 == 0 );
            if( len % 4 != 0 )
                throw new Error( "Incorrect stack frame values." );

            this.callStack        = new Array<DukCallStackEntry>();
            this.callStack.length = len/4;

            for( let i=1,j=0; i < len; i+=4, j++ )
            {
                this.callStack[j] = new DukCallStackEntry(
                    <string>msg[i]  .value,
                    <string>msg[i+1].value,
                    <number>msg[i+2].value,
                    <number>msg[i+3].value
                );
            }
        }
    }
}

export class DukGetLocalsResponse extends DukResponse
{
    // REP [ <str: varName> <tval: varValue> ]* EOM
    public vars:{name:string, value:any}[] = [];

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.GETLOCALS );

        let len = ( msg.length - 2 );
        if( len == 0 )
            return;

        assert( len % 2 == 0 );
        if( len % 2 != 0 )
            throw new Error( "Invalid 'GetLocals' response message." );

        this.vars.length = len/2;

        for( let i=1,j=0; i < len; i+=2, j++ )
        {
            let name = <string>msg[i].value
            let val  = msg[i+1].value;

            //if( val === undefined ) val = "undefined";
            //else if( val === null ) val = "null";
            //else val = val.toString();

            this.vars[j] = {
                name  : name,
                value : val
            };
        }
    }
}

export class DukListBreakResponse extends DukResponse
{
    public breakpoints:any[] = [];

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.LISTBREAK );

        let len = ( msg.length - 2 );
        if( len == 0 )
            return;

        assert( len % 2 == 0 );
        if( len % 2 != 0 )
            throw new Error( "Invalid 'ListBreakpoints' response message." );

        this.breakpoints.length = len/2;

        for( let i=1,j=0; i < len; i+=2, j++ )
        {
            this.breakpoints[j] = {
                fileName : <string>msg[i].value,
                line     : <string>msg[i+1].value
            };
        }
    }

}

export class DukEvalResponse extends DukResponse
{
    public success :boolean;
    public result  :Duk.DValueUnion;

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.EVAL );

        if( msg.length != 4 )
            throw new Error( "Invalid 'Eval' response message." );

        this.success = ((<number>msg[1].value) == 0);
        this.result  = <Duk.DValueUnion>msg[2].value;
    }
}

export class DukGetHeapObjInfoResponse extends DukResponse
{
    public properties:Duk.Property[];

    // REQ <int: 0x23> <tval: heapptr|object|pointer> EOM
    // REP [int: flags> <str/int: key> [<tval: value> OR <obj: getter> <obj: setter>]]* EOM
    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.GETHEAPOBJINFO );

        assert( msg.length >= 2 );

        this.properties = [];

        for( let i=1; i < msg.length-1; )
        {
            let prop = new Duk.Property();
            prop.flags = <number>       msg[i++].value;
            prop.key   = <number|string>msg[i++].value;
            prop.value = <any>          msg[i++].value;

            // If it's ann accessor, we must parse 2 values
            if( prop.flags & Duk.PropDescFlag.ATTR_ACCESSOR )
                prop.value = <any>[ prop.value, <any>msg[i++].value];
            
            this.properties.push( prop );
        }
    }
    
    // Returns the maximum number of properties 'own'
    // the object my have. The object is not guaranteed
    // to have this many properties, but might have less or none.
    // We obtain this by obtaining how many properties the
    // entry part and the array part can contain.
    // We do this by examining the "e_next" and a_size" artificial properties.
    // We add them both and that is our maximum possible number of properties 
    // that the object may have.
    // See the following docs:
    // https://github.com/svaarala/duktape/blob/v1.5.0/doc/debugger.rst
    // https://github.com/svaarala/duktape/blob/v1.5.0/doc/hobject-design.rst
    public get maxPropDescRange() : number
    {
        let e_next:Duk.Property, a_size:Duk.Property;

        for( let i = 0; i < this.properties.length; i++ )
        {
            if( this.properties[i].key == "e_next" ) {
                e_next = this.properties[i]; 
                break;
            }
        }

        for( let i = 0; i < this.properties.length; i++ )
        {
            if( this.properties[i].key == "a_size" ) {
                a_size = this.properties[i]; 
                break;
            }
        }

        return <number>e_next.value + <number>a_size.value;
    }

    // Return the value of the "e_next" property.
    // Which gives us the maximum number of properties in
    // the entry part of the object.
    public get maxPropEntriesRange() : number
    {
        for( let i = 0; i < this.properties.length; i++ )
        {
            if( this.properties[i].key == "e_next" )
                return <number>this.properties[i].value; 
        }
    }
}

// REQ <int: 0x25> <obj: target> <int: idx_start> <int: idx_end> EOM
// REP [<int: flags> <str/int: key> [<tval: value> OR <obj: getter> <obj: setter>]]* EOM

// Response is in the same format as DukGetHeapObjInfoResponse
export class DukGetObjPropDescRangeResponse extends DukGetHeapObjInfoResponse
{
    constructor( msg:DukDvalueMsg )
    {
        super( msg );
        this.cmd = Duk.CmdType.GETOBJPROPDESCRANGE;
    }
}


export class DukGetClosureResponse extends DukResponse
{
    // Taken from my modifications on duk_debugger.c:
    /* GetScopeKeys Format:
    * REQ <int: 0x7F> <int: scopeMask> [<int: stackLevel>] EOM
    * REP [<string: localKeys>*] <int: 0(end of scope)>
    *     [[<string: closureKeys*>] <int: 0(end of scope)>]
    *     [<string: globalKeys>*] <int: 0(end of scope)>
    *
    * Returns an array of keys for each scope. We support 3 scopes:
    *   Local    : 0x1
    *   Closures : 0x2
    *   Global   : 0x4
    *
    * scopeMask specifies whichs scopes to return. If a scope is not
    * specified in the mask, or if it is specified, but that scope does not
    * contain any keys, then no keys are returned, but the 'end of scope' marker
    * is always returned for each scope, except for closures. If closures are
    * not specified or a closure is empty, no scope end markes will be written.
    * In conclusion: The locals scope end marker is guaranteed and will always be the
    * first one, the globals scope end marker is also guaranteed and will always
    * be the last one. But no closure marker is guaranteed to appear.
    */
    public local   :string[];
    public closure :string[];
    public global  :string[];

    constructor( msg:DukDvalueMsg )
    {
        super( Duk.CmdType.GETSCOPEKEYS );

        /// Scopes are denoted by an array of strings, then a 0 as the end marker of a scope.
        /// The first scope is always the first scope, 
        /// the last scope on the list is always the global scope.
        /// If we have more than 2 scopes on the list, then any scope
        /// between the first and the last ( local and global ) are closure scopes.
        let scopes:string[][] = [];
        for( let i=1; i < msg.length-1; i++ )
        {
            let scope:string[] = [];
            for( ; i < msg.length-1; i++ )
            {
                // Check if the scope is finished?
                if( msg[i].type == Duk.DValKind.int )
                {
                    assert( (<number>msg[i].value) == 0 );
                    scopes.push( scope );
                    break;  // Continue to next scope
                }

                let name = <string>msg[i].value;
                scope.push( name );
            }
        }

        if( scopes.length < 2 )
            throw new Error( "GETSCOPEKEYS: Returned less than 2 scopes." );

        this.local   = scopes[0];
        this.global  = scopes[scopes.length-1];
        this.closure = [];

        if( scopes.length > 2 )
        {
            for( let i=1; i < scopes.length-1; i++ )
            {
                for( let j=0; j < scopes[i].length; j++ )
                    this.closure.push( scopes[i][j] );
            }
        }
       
    }
}

// Internal Classes
class DukMsgBuilder
{
    private length :number = 0;
    private buf    :Buffer;

    //-----------------------------------------------------------
    constructor( size:number )
    {
        this.buf = new Buffer( size );
    }

    //-----------------------------------------------------------
    public writeREQ() : void
    {
        this.writeByte( Duk.DvalIB.REQ );
    }

    //-----------------------------------------------------------
    public writeEOM() : void
    {
        this.writeByte( Duk.DvalIB.EOM );
    }

    //-----------------------------------------------------------
    public writeInt( val:number ) : void
    {
        assert( typeof val === "number" );

        val = Math.floor( val );

        if( val >= 0 && val <= 63 )
        {
            // small int
            this.writeByte( Duk.DvalIB.INTV_SM_MIN + val );
        }
        else if( val >= 0 && val <= 16383 )
        {
            // medium int
            let ib = Duk.DvalIB.INTV_LRG_MIN + (( val >> 8) & 0xFF);
            let sb = val & 0xFF;

            this.checkResize( 2 );
            this.buf.writeUInt8( ib, this.length   );
            this.buf.writeUInt8( sb, this.length+1 );
            this.length += 2;
        }
        else
        {
            // regular int
            this.checkResize( 5 );
            this.buf.writeUInt8( Duk.DvalIB.INT32, this.length++ );
            this.buf.writeInt32BE( val, this.length );
            this.length += 4;
        }
    }

    //-----------------------------------------------------------
    public writeString( val:string ) : void
    {
        assert( typeof val === "string" ||
                typeof val === "undefined" );

        // TODO: Need to use CESU-8, which is what duktape uses.
        if( val === undefined || val.length < 1 )
            this.writeUndefined();
        else
        {
            let strbuf:Buffer = this.encodeString( val );
            let len = strbuf.length;

            // Reserve size for worst-case scenario ( ie: 4-byte length uint )
            this.checkResize( len + 4 );

            // Write length first
            if( val.length <= 31 )
            {
                this.buf.writeUInt8( Duk.DvalIB.STRV_MIN + len,
                                     this.length++ );
            }
            else if( val.length <= 65535 )
            {
                this.buf.writeUInt8( Duk.DvalIB.STR16, this.length++ );
                this.buf.writeUInt16BE( len, this.length );
                this.length += 2;
            }
            else
            {
                this.buf.writeUInt8( Duk.DvalIB.STR32, this.length++ );
                this.buf.writeUInt32BE( len, this.length );
                this.length += 4;
            }

            // Write string data
            strbuf.copy( this.buf, this.length, 0, len );
            this.length += len;
        }
    }

    //-----------------------------------------------------------
    public writePointer( ptr:Duk.TValPointer ) : void
    {
        this.checkResize( 2 + ptr.size );
        this.buf.writeUInt8( Duk.DvalIB.POINTER, this.length++ );
        this.buf.writeUInt8( ptr.size, this.length++ );

        this.buf.writeUInt32BE( ptr.lopart, this.length );

        if( ptr.size == 8 )
            this.buf.writeUInt32BE( ptr.hipart, this.length+4 );

        this.length += ptr.size;
    }

    //-----------------------------------------------------------
    public writeUndefined() : void
    {
        this.checkResize( 1 );
        this.buf.writeUInt8( Duk.DvalIB.UNDEFINED, this.length++ );
    }

    //-----------------------------------------------------------
    public writeByte( val:number ) : void
    {
        this.checkResize(1);
        this.buf.writeUInt8( val, this.length++ );
    }

    //-----------------------------------------------------------
    public finish() : Buffer
    {
        let newBuf = new Buffer( this.length );

        if( this.length > 0 )
            this.buf.copy( newBuf, 0, 0, this.length );

        this.clear();

        return newBuf;
    }

    //-----------------------------------------------------------
    public clear() : void
    {
        this.length = 0;
    }

    //-----------------------------------------------------------
    // Duktape says it uses CESU-8 for strings ( investigate ).
    //  For now, just do UTF-8 for internal use
    //-----------------------------------------------------------
    private encodeString( val:string ) : Buffer
    {
        // TODO: Encode as CESU-8, which is what the docs say it uses
        let len = Buffer.byteLength( val, "utf8" );
        let buf:Buffer = new Buffer( len );

        // Might need to write null terminator?
        buf.write( val, 0 );

        return buf;
    }

    //-----------------------------------------------------------
    private checkResize( writeSize:number ) : void
    {
        let requiredSize = ( this.length + writeSize );
        if( requiredSize > this.buf.length )
        {
            let newBuf = new Buffer( requiredSize  );
            this.buf.copy( newBuf, 0, 0, this.length );
            this.buf = newBuf;
        }
    }
}

class PromiseContext
{
    public resolve :Function;
    public reject  :Function;
}

class PendingRequest
{
    public cmd      :number;
    public sequence :number;
    public promise  :Promise<any>;
    public pcontext :PromiseContext;
    public buf      :Buffer;
    public timerID  :NodeJS.Timer;


    constructor( cmd:number, sequence:number, promise:Promise<any>,
                 pcontext:any, buf:Buffer )
    {
        this.cmd      = cmd      ;
        this.sequence = sequence ;
        this.promise  = promise  ;
        this.pcontext = pcontext ;
        this.buf      = buf      ;
    }
}

export enum DukEvent
{
    disconnected = 0,
    attached,

    // Notification Events
    nfy_status   ,
    nfy_print    ,
    nfy_alert    ,
    nfy_log      ,
    nfy_throw    ,
    nfy_detaching,
}

enum State
{
    Offline = 0,
    Connecting,
    Verification,
    Online
}

export class DukDbgProtocol extends EE.EventEmitter
{

    private static OUT_BUF_SIZE :number  = 1024*1;  // Resizable
    private static IN_BUF_SIZE  :number = 1024*16;  // Fixed

    private _state          :State = State.Offline;
    private _dukSocket      :Net.Socket;

    private _outBuf         :DukMsgBuilder;
    private _inBufSize      :number;
    private _inBuf          :Buffer;
    private _inReadPos      :number;

    private _numDvalues     :number;
    private _msg            :Array<Duk.DValue>;

    private _requestSequence:number;                // Current outgoing request sequence
    private _requestQueue   :PendingRequest[];      // Requests that have been queued up for execution
    private _curRequest     :PendingRequest;        // Last request made. We're expecting a response to it.

    private _protoVersion   :string = null;

    private log:Function;
    
    public  info:DukBasicInfoResponse;

    //-----------------------------------------------------------
    constructor( logger:Function )
    {
        super();

        this.log = ( logger || (() => {}) );

        this._inBufSize = 0;

        this._outBuf    = new DukMsgBuilder( DukDbgProtocol.OUT_BUF_SIZE );
        this._inBuf     = new Buffer( DukDbgProtocol.IN_BUF_SIZE );
        this._inBuf.fill( 0 );

        this._msg        = [];
        this._numDvalues = 0;
    }

    //-----------------------------------------------------------
    public attach( ip:string, port:number, timeoutMS:number = 5000 ) : void
    {
        assert( this._state == State.Offline );

        if( this._state != State.Offline )
            return;

        this.log( `Establishing connection with Duktape at ${ip}:${port}` );

        this._state     = State.Connecting;
        this._dukSocket = new Net.Socket();

        // Check for timeout
        var timeoutID:NodeJS.Timer = setTimeout( () => {

            clearTimeout( timeoutID );

            if( this._state == State.Connecting )
            {
                this.disconnect( "Connection attempt timed-out" );
            }

            // If the state is not connecting,
            // the connection was either interrupted or succesful.

        }, timeoutMS );


        // On succesful connection
        this._dukSocket.once( "connect", ( event:Event ) => {

            clearTimeout( timeoutID );

            // Don't know if this can happen, but just in case
            if( this._state != State.Connecting )
                return;

            this.log( "Connected. Verifying protocol..." );
            this._state = State.Verification;
            this.reset();

            // TODO: Set new timeout for verification?

            // Start listening for data
            this._dukSocket.on( "data", ( buf:Buffer ) => this.onReceiveData( buf ) );

            this._dukSocket.on( "close", () => {
                this.log( "Socket closed." );
            });
        });

        // On error
        this._dukSocket.on( "error", (error) => {

            if( this._state == State.Connecting )
            {
                // Attempt to reconnect as long as we haven't timed out
                this._dukSocket.connect( port, ip );
            }
            else if( this._state >= State.Verification )
            {
                // Connection error
                this.disconnect( String(error) );
            }
            else
            {
                // This means the connection attempt timed-out
                //  or was interrupted by the user. The state is already offline.,
            }

        });

        this._dukSocket.connect( port, ip );
    }

    //-----------------------------------------------------------
    public disconnect( reason:string = "" ) : void
    {
        if( this._state == State.Offline )
            return;

        if( this._state == State.Connecting )
            this.log( "Connection attempt cancelled." );

        // Close the socket
        this._state = State.Offline;
        
        this._dukSocket.end();
        this._dukSocket.destroy();
        this._dukSocket = null;
        
        this.emit( DukEvent[DukEvent.disconnected], reason );
    }

/// Requests/Commands
    //-----------------------------------------------------------
    public requestBasicInfo() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.BASICINFO );
    }
    
    //-----------------------------------------------------------
    public requestResume() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.RESUME );
    }

    //-----------------------------------------------------------
    public requestPause() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.PAUSE );
    }

    //-----------------------------------------------------------
    public requestCallStack() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.GETCALLSTACK );
    }

    //-----------------------------------------------------------
    public requestStepOver() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.STEPOVER );
    }

    //-----------------------------------------------------------
    public requestStepInto() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.STEPINTO );
    }

    //-----------------------------------------------------------
    public requestStepOut() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.STEPOUT );
    }

    //-----------------------------------------------------------
    public requestSetBreakpoint( file:string, line:number ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.ADDBREAK );
        this._outBuf.writeString( file );
        this._outBuf.writeInt( line );
        this._outBuf.writeEOM();

        return this.sendRequest( Duk.CmdType.ADDBREAK, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    public requestRemoveBreakpoint( index:number ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.DELBREAK );
        this._outBuf.writeInt( index );
        this._outBuf.writeEOM();

         return this.sendRequest( Duk.CmdType.DELBREAK, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    public requestListBreakpoints() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.LISTBREAK );
    }

    //-----------------------------------------------------------
    public requestDetach() : Promise<any>
    {
        return this.sendSimpleRequest( Duk.CmdType.DETACH );
    }

    //-----------------------------------------------------------
    // stackLevel: Top of the stack (current) is -1,
    //  the caller of that one is -2 and so on
    //-----------------------------------------------------------
    public requestLocalVariables( stackLevel:number ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.GETLOCALS );
        this._outBuf.writeInt( stackLevel );
        this._outBuf.writeEOM();

        return this.sendRequest( Duk.CmdType.GETLOCALS, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    public requestEval( expression:string, stackLevel:number = -1 ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.EVAL );
        this._outBuf.writeString( expression );
        this._outBuf.writeInt( stackLevel );
        this._outBuf.writeEOM();

        return this.sendRequest( Duk.CmdType.EVAL, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    public requestInspectHeapObj( ptr:Duk.TValPointer, flags:number = 0 ) : Promise<any>
    {
        if( !ptr || ( !ptr.lopart && !ptr.hipart ) )
        {
            this.log( "requestInspectHeapObj: Warning pointer was NULL" );
            return Promise.reject( null );
        }

        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.GETHEAPOBJINFO );
        this._outBuf.writePointer( ptr );
        this._outBuf.writeInt( flags );
        this._outBuf.writeEOM();

        return this.sendRequest( Duk.CmdType.GETHEAPOBJINFO, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    public requestGetObjPropDescRange( ptr:Duk.TValPointer, idxStart:number, idxEnd:number ) : Promise<any>
    {
        if( !ptr || ( !ptr.lopart && !ptr.hipart ) )
        {
            this.log( "requestGetObjPropDescRange: Warning pointer was NULL" );
            return Promise.reject( null );
        }

        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.GETOBJPROPDESCRANGE );
        this._outBuf.writePointer( ptr );
        this._outBuf.writeInt( idxStart );
        this._outBuf.writeInt( idxEnd );
        this._outBuf.writeEOM();

        return this.sendRequest( Duk.CmdType.GETOBJPROPDESCRANGE, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    // This request is Musashi-specific.
    //-----------------------------------------------------------
    public requestClosures( mask:DukScopeMask, stackDepth:number = -1 ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( Duk.CmdType.GETSCOPEKEYS );
        this._outBuf.writeInt( mask );
        this._outBuf.writeInt( stackDepth );
        this._outBuf.writeEOM();
        
        return this.sendRequest( Duk.CmdType.GETSCOPEKEYS, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    private sendSimpleRequest( cmd:number ) : Promise<any>
    {
        this._outBuf.clear();
        this._outBuf.writeREQ();
        this._outBuf.writeInt( cmd );
        this._outBuf.writeEOM();

        return this.sendRequest( cmd, this._outBuf.finish() );
    }

    //-----------------------------------------------------------
    private sendRequest( cmd:number, buf:Buffer ) : Promise<any>
    {
        assert( this._state == State.Online );

        if( this._state != State.Online )
            return Promise.reject( "offline" );

        var pcontext = new PromiseContext();

        let cb = ( resolve, reject:any ) =>
        {
            pcontext.resolve = resolve;
            pcontext.reject  = reject;
        };

        let p   = new Promise<any>( cb );
        let req = new PendingRequest( cmd, ++this._requestSequence,
                                      p, pcontext, buf );

        if( this._curRequest != null )
        {
            // There's still a request pending, queue this one instead
            this._requestQueue.push( req );
        }
        else
        {
            // Submit the request immediately
            if( !this.submitRequest( req ) )
                return Promise.reject( "Failed to submit request." );
        }

        return p;
    }

    //-----------------------------------------------------------
    private submitRequest( req:PendingRequest ) : boolean
    {
        assert( this._curRequest == null );

        if( MSG_TRACING )
        {
            let cmd = req.cmd;
            this.log( `OUT -> <REQ: ${Duk.DvalIB.REQ}> <0x${cmd.toString(16)}: ${Duk.CmdType[cmd]}>` );
        }

        // Send request down the stream
        if( !this._dukSocket.write( req.buf ) )
        {
            this.disconnect( "Failed to write data to socket." );
            return false;
        }

        this._curRequest = req;
        return true;
    }

/// DataRead
    //-----------------------------------------------------------
    private onReceiveData( data:Buffer ) : void
    {
        assert( this._dukSocket != null && this._state >= State.Verification );

        if( this._dukSocket == null )
            return;

        let buf = this._inBuf;

        if( !this.readData( data ) )
        {
            // Buffer overflow
            this.log( "The receive buffer overflowed." );
            this.disconnect( "The receive buffer overflowed." );

            return;
        }

        if( this._protoVersion == null )
        {
            // Attempt to get protocol version
            if( this._inBufSize > 1024 )
            {
                this.log( "Parse error (version identification too long), dropping connection" );
                this.disconnect( "Parse error (version identification too long), dropping connection" );

                return;
            }

            // Attempt to get version string
            for( let i = 0; i < this._inBufSize; i++ )
            {
                if( buf[i] == 0x0A )
                {
                    let verBuffer = new Buffer( i );
                    buf.copy( verBuffer, 0, 0, i );
                    this.consume( i+1 );

                    this._protoVersion = verBuffer.toString( "utf8" );
                    this.log( "Protocol: " + this._protoVersion );
                    
                // TODO: Verify protocol version

                    // Now request the target's info to finalize attach step
                    this.log( "Requesting target info..." );
                    
                    // Switch the state real quick, since this call is protected... hacky...
                    this._state = State.Online;
                    this.requestBasicInfo().then( ( r:DukBasicInfoResponse ) => {
                    
                        // Save basic info
                        this.info = r;
                        this.log( `${r.version} ${r.gitDesc} ${r.targetInfo} ${DukEndianness[r.endianness]}` );
                        
                        // Emit attached
                        this._state = State.Online;
                        this.emit( DukEvent[DukEvent.attached], true );
                        
                    }).catch( ( err ) => {
                        this.disconnect( `Error obtaining basic info: ${String(err)}` );
                    });
                    
                    // Restore state
                    this._state = State.Verification;

                    break;
                }
            }
        }

        if( !this._protoVersion )
            return;     // Still waiting for protocol version or target info
        

        // Attempt to frame a message
        this.readMessages();

        // Check if we read anything from the buffer
        if( this._inReadPos > 0 )
        {
            this.consume( this._inReadPos );
            this._inReadPos = 0;
        }
    }

    //-----------------------------------------------------------
    /// Attempts to frame messages by reading a sequence of dvalues.
    /// Then dispatches the message to be translated ( validated ) & handled
    //  See duk_debug.js : DebugProtocolParser
    //-----------------------------------------------------------
    private readMessages() : void
    {
        let buf       = this._inBuf;
        let pos       = 0;
        let available = this._inBufSize;

        let remaining = () => available - pos;

        // Helper to read pointers
        let readPtr = ( size:number ) => {

            let dvalBuf = new Buffer( size );
            buf.copy( dvalBuf, 0, pos, pos + size );

            let lopart = 0, hipart = 0;

            // Pointers are stored in the byte order 
            // of the client, to facilitate inspection.

            if( size == 4 )
            {
                // Store as little-endian if that's our byte order
                lopart = dvalBuf.readUInt32BE( 0 );
            }
            else if( size == 8 )
            {
                // On LE systems hipart and lopart should be swapped,
                // but we want to keep them like this simply to have them
                // display properly on toString calls. Since we won't treat them as a QWORD anyway
                hipart = dvalBuf.readUInt32BE( 0 );
                lopart = dvalBuf.readUInt32BE( 4 );
            }
            else
                throw new Error( `Unknown pointer size: ${size}` );

            return new Duk.TValPointer( size, lopart, hipart );
        };

        while( pos < available )
        {
            let x            = buf[pos++];
            let v:Duk.DValue = undefined;
            let gotValue     = false;       // used to flag special values like undefined

            if( x >= Duk.DvalIB.INTV_LRG_MIN )
            {
                // 0xc0...0xff: integers 0-16383
                if( remaining() < 1 )
                    return; // not enough data to parse dvalue

                v = new Duk.DValue( Duk.DValKind.int,
                                   ((x - 0xc0) << 8) + buf[pos++] );
            }
            else if( x >= Duk.DvalIB.INTV_SM_MIN )
            {
                // 0x80...0xbf: integers 0-63
                v = new Duk.DValue( Duk.DValKind.int, x - 0x80 );
            }
            else if( x >= Duk.DvalIB.STRV_MIN )
            {
                // 0x60...0x7f: strings with length 0-31
                let len = x - 0x60;
                if( remaining() >= len )
                {
                    v = new Duk.DValue( Duk.DValKind.str,
                             this.bufferToDebugString( buf, pos, len ) );
                    pos += len;
                }
                else
                    return; // not enough data to parse dvalue
            }
            else
            {
                switch( x )
                {
                    case Duk.DvalIB.REQ :
                    case Duk.DvalIB.REP :
                    case Duk.DvalIB.ERR :
                    case Duk.DvalIB.NFY :
                        assert( this._msg.length === 0 );
                        v = new Duk.DValue( x, x );
                    break;
                    case Duk.DvalIB.EOM :
                        v = new Duk.DValue( Duk.DValKind.EOM, Duk.DvalIB.EOM );
                        assert( this._msg.length > 0 );
                    break;

                    // 0x10 4-byte signed integer
                    case Duk.DvalIB.INT32 :

                        if( remaining() < 4 )
                            return;

                        v = new Duk.DValue( Duk.DValKind.int, buf.readInt32BE( pos ) );
                        pos += 4;

                    break;

                    // 0x11 4-byte string
                    case Duk.DvalIB.STR32 :

                        if( remaining() >= 4 )
                        {
                            let len = buf.readUInt32BE( pos );
                            pos += 4;

                            if( remaining() < len )
                                return;

                            v = new Duk.DValue( Duk.DValKind.str,
                                                this.bufferToDebugString( buf, pos, len ) );
                            pos += len;
                        }
                        else
                            return;

                    break;

                    // 0x12 2-byte string
                    case Duk.DvalIB.STR16 :

                        if( remaining() >= 2 )
                        {
                            let len = buf.readUInt16BE( pos );
                            pos += 2;

                            if( remaining() < len )
                                return;

                            v = new Duk.DValue( Duk.DValKind.str,
                                                this.bufferToDebugString( buf, pos, len ) );
                            pos += len
                        }
                        else
                            return;

                    break;

                    // 0x13 4-byte buffer
                    case Duk.DvalIB.BUF32 :

                        if( remaining() >= 4 )
                        {
                            let len = buf.readUInt32BE( pos );
                            pos += 4;

                            if( remaining() < len )
                                return;

                            let dvalBuf = new Buffer( len );
                            buf.copy( dvalBuf, 0, pos, pos + len );

                            v = new Duk.DValue( Duk.DValKind.buf, dvalBuf );
                            pos += len;
                        }
                        else
                            return;
                    break;

                    // 0x14 2-byte buffer
                    case Duk.DvalIB.BUF16 :

                        if( remaining() >= 2 )
                        {
                            let len = buf.readUInt16BE( pos );
                            pos += 2;

                            if( remaining() < len )
                                return;

                            let dvalBuf = new Buffer( len );
                            buf.copy( dvalBuf, 0, pos, pos + len );

                            v = new Duk.DValue( Duk.DValKind.buf, dvalBuf );
                            pos += len;
                        }
                        else
                            return;

                    break;

                    // 0x15 unused/none
                    case Duk.DvalIB.UNUSED :
                        v = new Duk.DValue( Duk.DValKind.tval, undefined );
                    break;

                    // 0x16 undefined
                    case Duk.DvalIB.UNDEFINED :
                        v = new Duk.DValue( Duk.DValKind.tval, undefined );
                    break;

                    //  0x17 null
                    case Duk.DvalIB.NULL :
                        v = new Duk.DValue( Duk.DValKind.tval, null );
                    break;

                    // 0x18 true
                    case Duk.DvalIB.TRUE :
                       v = new Duk.DValue( Duk.DValKind.tval, true );
                    break;

                    // 0x19 false
                    case Duk.DvalIB.FALSE :
                        v = new Duk.DValue( Duk.DValKind.tval, false );
                    break;

                    // 0x1a number (IEEE double), big endian
                    case Duk.DvalIB.NUMBER :

                        if( remaining() >= 8 )
                        {
                            v = new Duk.DValue( Duk.DValKind.tval, buf.readDoubleBE( pos ) );
                            pos += 8;
                        }
                        else
                            return;

                    break;

                    // 0x1b object
                    case Duk.DvalIB.OBJECT :

                        if( remaining() >= 2 )
                        {
                            let cls = buf[pos];
                            let len = buf[pos+1];

                            pos += 2;

                            if( remaining() < len )
                                return;

                            let ptr = readPtr( len );
                            v = new Duk.DValue( Duk.DValKind.tval, new Duk.TValObject( cls, ptr ) );

                            pos += len;
                        }
                        else
                            return;

                    break;

                    // 0x1c pointer
                    case Duk.DvalIB.POINTER :

                        if( remaining() >= 1 )
                        {
                            let len = buf[pos++];

                            if( remaining() < len )
                                return;

                            let ptr = readPtr( len );
                            v = new Duk.DValue( Duk.DValKind.ptr, ptr );

                            pos += len;
                        }
                        else
                            return;

                    break;

                    // 0x1d lightfunc
                    case Duk.DvalIB.LIGHTFUNC :

                        if( remaining() >= 3 )
                        {
                            let flags = buf.readUInt16BE( pos );
                            let len   = buf[pos+2];
                            pos += 3;

                            if( remaining() < len )
                                return;

                            let ptr = readPtr( len );
                            v = new Duk.DValue( Duk.DValKind.tval, new Duk.TValLightFunc( flags, ptr) );

                            pos += len;

                        }
                        else
                            return;

                    break;

                    // 0x1e heapptr
                    case Duk.DvalIB.HEAPPTR :

                        if( remaining() >= 1 )
                        {
                            let len = buf[pos++];

                            if( remaining() < len )
                                return;

                            let ptr = readPtr( len );

                            // TODO: Make a new type HeapPtr?
                            v = new Duk.DValue( Duk.DValKind.tval, ptr );
                            pos += len;
                        }
                        else
                            return;
                    break;

                    default :
                        this.disconnect( "DVal parse error, dropping connection." );
                        return;
                }
            }

            // Add new values
            assert( v );

            this._msg.push( v );
            this._numDvalues ++;

            // Set buffer consumed position
            this._inReadPos = pos;

            // Check if we have a fully framed message
            if( x === Duk.DvalIB.EOM )
            {
                // Translate and dispatch message
                this.translateMessage( this._msg );
                this._msg = [];
            }

        } // End while
    }

    //-----------------------------------------------------------
    private translateMessage( msg:DukDvalueMsg ) : void
    {
        assert( msg.length > 0 );

        // Determine message type by initial byte
        let ib = <number>msg[0].value;

        // Print incoming message
        if( MSG_TRACING )
        {
            if( LOG_STATUS_NOTIFY ||
                ( msg[0].value != Duk.MsgType.NFY ||
                  msg[1].value != Duk.NotifyType.STATUS ) )
            {
                let mStr = "IN <- ";
                for( let i=0; i < msg.length; i++ )
                {
                    let dval = msg[i];
                    mStr += `<${Duk.DValKind[dval.type]}: ${String(dval.value)}> `;
                }
                this.log( mStr );
            }            
        }

        switch( ib )
        {
            default :
                this.log( `warning: Received unknown message type: 0x${(<number>ib).toString(16)}. Discarding.` );
                return;
            case Duk.MsgType.EOM :
                this.log( "warning: Received empty message, discarding." );
                return;

            case Duk.MsgType.REQ :
                this.parseRequestMessage( msg );
            break;

            case Duk.MsgType.REP :
            case Duk.MsgType.ERR :
                this.parseResponseMessage( msg );
            break;

            case Duk.MsgType.NFY :
                this.parseNotificationMessage( msg );
            break;
        }
    }

    //-----------------------------------------------------------
    private parseRequestMessage( msg:DukDvalueMsg ) : void
    {
        // DukDebug should never send any requests.
        throw new Error( "Received request message." );
    }

    //-----------------------------------------------------------
    private parseNotificationMessage( msg:DukDvalueMsg ) : void
    {
        try {
            let id:number = <number>msg[1].value;

            switch( id )
            {
                case Duk.NotifyType.STATUS    :
                    this.emit( DukEvent[DukEvent.nfy_status], new DukStatusNotification( msg ) );
                break;

                case Duk.NotifyType.PRINT     :
                    this.emit( DukEvent[DukEvent.nfy_print], new DukPrintNotification( msg ) );
                break;

                case Duk.NotifyType.ALERT     :
                    this.emit( DukEvent[DukEvent.nfy_alert], new DukAlertNotification( msg ) );
                break;

                case Duk.NotifyType.LOG       :
                    this.emit( DukEvent[DukEvent.nfy_log], new DukLogNotification( msg ) );
                break;

                case Duk.NotifyType.THROW     :
                    this.emit( DukEvent[DukEvent.nfy_throw], new DukThrowNotification( msg ) );
                break;

                case Duk.NotifyType.DETACHING :
                {
                    let reason = `Target detached: ( ${msg[2].value} )  ${msg[3].value}`;
                    this.disconnect( reason );
                }
                break;

                case Duk.NotifyType.APP_MSG:
                    throw new Error( "Unimplemented" );
                break;
            }
        }
        catch( err ) {
            this.log( "Error parsing notification message: " + err );
        }

    }

    //-----------------------------------------------------------
    private parseResponseMessage( msg:DukDvalueMsg ) : void
    {
        assert( this._curRequest != null );

        let req = this._curRequest;
        this._curRequest = null;

        if( !req )
        {
            this.log( "Warning: Received a response without a request!" );
            return;
        }

        let cmd = req.cmd;

        if( msg[0].value == Duk.MsgType.ERR )
        {
            let errType:number = msg.length > 2 ? <number>msg[1].value : 0;
            let errMsg :string = msg.length > 3 ? <string>msg[2].value : "";

            let errStr = `Request ${Duk.MsgType[cmd]} returned error: `+
                         `${Duk.ERR_TYPE_MAP[errType]} : ${errMsg}`;

            this.log( errStr );
            req.pcontext.reject( errStr );
        }
        else
        {
            // Get any value we need
            let value  = undefined;
            let failed = false;
            try {

                switch( cmd )
                {
                    default :
                        assert( false );
                    break;

                    // No OP responses
                    case Duk.CmdType.PAUSE          :
                    case Duk.CmdType.RESUME         :
                    case Duk.CmdType.STEPINTO       :
                    case Duk.CmdType.STEPOVER       :
                    case Duk.CmdType.STEPOUT        :
                    case Duk.CmdType.DELBREAK       :
                    case Duk.CmdType.DETACH         :
                     case Duk.CmdType.TRIGGERSTATUS  :
                        // No value needed
                    break;

                    case Duk.CmdType.BASICINFO      :
                        value = new DukBasicInfoResponse( msg );
                    break;

                    case Duk.CmdType.LISTBREAK      :
                        value = new DukListBreakResponse( msg );
                    break;

                    case Duk.CmdType.ADDBREAK       :
                        value = new DukAddBreakResponse( msg );
                    break;

                    case Duk.CmdType.GETVAR         :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.PUTVAR         :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.GETCALLSTACK   :
                        value = new DukGetCallStackResponse( msg );
                    break;

                    case Duk.CmdType.GETLOCALS      :
                        value = new DukGetLocalsResponse( msg );
                    break;

                    case Duk.CmdType.EVAL           :
                        value = new DukEvalResponse( msg );
                    break;

                    case Duk.CmdType.DUMPHEAP       :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.GETBYTECODE    :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.APPCOMMAND     :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.GETHEAPOBJINFO :
                        value = new DukGetHeapObjInfoResponse( msg );
                    break;

                    case Duk.CmdType.GETOBJPROPDESC :
                        throw new Error( "Unimplemented" );
                    break;

                    case Duk.CmdType.GETOBJPROPDESCRANGE :
                        value = new DukGetObjPropDescRangeResponse( msg );
                    break;

                    case Duk.CmdType.GETSCOPEKEYS    :
                        value = new DukGetClosureResponse( msg );
                    break;
                }
            }
            catch( err )
            {
                req.pcontext.reject( err );
                failed = true;
            }

            // Complete promise
            if( !failed )
                req.pcontext.resolve( value );
        }

        // Process next queued request, if any
        while( this._requestQueue.length > 0 )
        {
            let req = this._requestQueue.shift();

            if( this.submitRequest( req ) )
                break;
            else
                req.pcontext.reject( "Failed to submit request." );
        }

    }

    //-----------------------------------------------------------
    // From duk_debug.js:
    // Convert a buffer into a string using Unicode codepoints U+0000...U+00FF.
    //  This is the NodeJS 'binary' encoding, but since it's being deprecated,
    //  reimplement it here.  We need to avoid parsing strings as e.g. UTF-8:
    //  although Duktape strings are usually UTF-8/CESU-8 that's not always the
    //  case, e.g. for internal strings.  Buffer values are also represented as
    //  strings in the debug protocol, so we must deal accurately with arbitrary
    //  byte arrays.
    //-----------------------------------------------------------
    private bufferToDebugString( buf:Buffer, pos:number, len:number ) : string
    {
        let cp = new Array( len );

        // TODO@Harold : I think this reads only ascii characters, since its 
        // treating each byte as a code point. Need to make it properly

        ///*
        // This fails with "RangeError: Maximum call stack size exceeded" for some
        // reason, so use a much slower variant.

        for( let i = 0; i < len; i++ ) {
            cp[i] = buf[pos+i];
        }

        return String.fromCharCode.apply(String, cp);
        //*/

        /*
        for( let i = 0; i < len; i++ ) {
            cp[i] = String.fromCharCode( buf[pos+i] );
        }

        return cp.join('');
        //*/

    }

    //-----------------------------------------------------------
    private readData( data:Buffer ) : boolean
    {
        let buf       = this._inBuf;
        let available = data.length;

        if( ( this._inBufSize + available ) > buf.length )
            return false;

        data.copy( buf, this._inBufSize, 0, available );
        this._inBufSize += available;

        return true;
    }

    //-----------------------------------------------------------
    private consume( count:number ) : void
    {
        let remainder = this._inBufSize - count;
        if( remainder > 0 )
            this._inBuf.copy( this._inBuf, 0, count, this._inBufSize );   // Move memory down

        this._inBufSize = remainder;
    }

    //-----------------------------------------------------------
    private reset() : void
    {
        this._inBufSize  = 0;
        this._inReadPos  = 0;
        this._numDvalues = 0;
        this._msg        = [];

        this._requestSequence = 0;
        this._curRequest      = null;
        this._requestQueue    = [];
    }

    //-----------------------------------------------------------
    private closeSocket() : void
    {
        if( !this._dukSocket )
            return;


    }

}

//} // End NS