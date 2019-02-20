import * as Net    from "net"   ;
import * as EE     from "events";
import * as assert from "assert";

enum State
{
    Offline = 0,
    Connecting,
    Verification,
    Online
}


export interface DukVersion
{
    id         :string; // Version id string received
    proto      :number; // Protocol version (equivalent to DUK_DEBUG_PROTOCOL_VERSION)
    dukVersion :number; // Duktape version (equivalent to DUK_VERSION)
    gitDescribe:string; // Equivalent to DUK_GIT_DESCRIBE
    target     :string; // Debug target name

    // DUK_VERSION components
    major:number;
    minor:number;
    patch:number;
}

export class DukConnection extends EE.EventEmitter
{
    _state :State = State.Offline;
    _socket:Net.Socket;
    _protoVersion:DukVersion;

    private dbgLog: ( msg:string ) => void;

    //-----------------------------------------------------------
    private constructor()
    {
        super();
    }

    //-----------------------------------------------------------
    public static connect( ip:string, port:number, timeoutMS:number = 5000,
                           dbgLog?:( msg:string ) => void ):DukConnection
    {
        const con = new DukConnection();
        con.dbgLog = dbgLog || <any>(() => {});
        con._connect( ip, port, timeoutMS );

        return con;
    }

    //-----------------------------------------------------------
    private _connect( ip:string, port:number, timeoutMS:number ):void
    {
        const sock = new Net.Socket();

        this.log( `Establishing connection with Duktape at ${ip}:${port}` );

        sock.setTimeout( timeoutMS, () => {
            this.dbgLog( `Connection timed out.` );
            this.onError( new Error("Connection timed out." ) );
        });

        sock.once( "error", (error) => {
            this.dbgLog( `Connection error: ${error}` );
            this.onError( error );
        });

        sock.on( "close", () => {
            this.closeSocket( "Socked closed unexpectedly." );
        });

        sock.once( "connect", ( event:Event ) => {

            this.log( "Connected. Verifying protocol..." );
            this._state = State.Verification;

            sock.setTimeout( 0 );

            // Start listening for data
            const inBuf :Buffer = new Buffer( 2048 );
            let inSize:number = 0;

            const onData = ( data:Buffer ) =>
            {
                const rem = inBuf.length - inSize;

                if( rem < 1 )
                {
                    // Error, version identification msg too long
                    this.onError( new Error( "Parse error (version identification too long), dropping connection" ) );
                    return;
                }

                // Fill in buffer with as much data as we can
                const bytesToCopy = rem < data.length ? rem : data.length;
                data.copy( inBuf, inSize, 0, bytesToCopy );
                inSize += bytesToCopy;

                // Attempt to get protocol version string
                for( let i = 0; i < inSize; i++ )
                {
                    // Find first new line character
                    if( inBuf[i] !== 0x0A )
                    {
                        continue;
                    }

                    let verBuffer = new Buffer( i );
                    inBuf.copy( verBuffer, 0, 0, i );

                    const idString = verBuffer.toString( "utf8" );
                    this.dbgLog( "Protocol ID: " + idString );

                    let version:DukVersion;
                    // Parse the protocol version
                    // See: https://github.com/svaarala/duktape/blob/master/doc/debugger.rst#version-identification
                    try {

                        let split        = idString.split( ' ' );
                        const dukVersion = Number( split[1] );

                        version = {
                            id          : idString,
                            proto       : Number( split[0] ),
                            dukVersion  : dukVersion,
                            gitDescribe : split[2],
                            target      : split[3],
                            major       : Math.floor( dukVersion / 10000 ),
                            minor       : (dukVersion / 100) % 100,
                            patch       : dukVersion % 100,
                        };

                        this._protoVersion = version;
                    }
                    catch( err ) {
                        this.onError( new Error( `Error validating protocol version: ${err}` ) );
                        return;
                    }

                    sock.removeListener( "data", onData );

                    // Copy any remaining bytes received and hand them over to the user
                    const inRem    = inSize - i-1;
                    const dataRem  = data.length - bytesToCopy;

                    const remBuf = new Buffer( inRem + dataRem );
                    if( inRem > 0 )
                    {
                        inBuf.copy( remBuf, 0, i+1, inSize );
                    }
                    if( dataRem > 0 )
                    {
                        data.copy( remBuf, inRem, bytesToCopy, dataRem );
                    }

                    // Emit connected event
                    this.onConnected( remBuf, version );
                    return;
                }

                // if we get here, and we didn't manage to
                // read the whole buffer, then we've overflowed.
                if( bytesToCopy < data.length )
                {
                    this.onError( new Error( "Input buffer overflow" ) );
                }
            }

            sock.on( "data", onData );
        });

        sock.connect( port, ip );
        this._socket = sock;
        this._state  = State.Connecting;
    }

    //-----------------------------------------------------------
    public closeSocket( reason?:string ):void
    {
        try {
            this._socket.removeAllListeners();
            this._socket.destroy();
            this._socket = null;

            this.dbgLog( `Socket closed: ${reason}` );

            this.onDisconnect( reason );
        }
        catch( e ) {}
    }

    /// Events:
    //-----------------------------------------------------------
    private onConnected( buf:Buffer, version:DukVersion ):void
    {
        this._state = State.Online;
        this.emit( "connected", buf, version );
    }

    //-----------------------------------------------------------
    private onError( err:Error ):void
    {
        this.closeSocket( `Connection error: ${err}` );
        this.emit( "error", err );
    }

    //-----------------------------------------------------------
    private onDisconnect( reason?:string ):void
    {
        this.emit( "disconnect", reason || "" );
    }

    //-----------------------------------------------------------
    private log( msg:string ):void
    {
        console.log( msg );
    }

}