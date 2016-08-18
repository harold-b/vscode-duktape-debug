
// Please see: https://github.com/svaarala/duktape/blob/master/doc/debugger.rst
//namespace Duk {

    export enum MsgType
    {
        EOM = 0x00,     // End of message
        REQ = 0x01,     // Start of request message
        REP = 0x02,     // Start of success reply message
        ERR = 0x03,     // Start of error reply message
        NFY = 0x04,     // Start of notification message
    }

    // DValue initial bytes
    export enum DvalIB
    {
        // Message types
        EOM               = MsgType.EOM,
        REQ               = MsgType.REQ,
        REP               = MsgType.REP,
        ERR               = MsgType.ERR,
        NFY               = MsgType.NFY,
        
        // RESERVED       = 0x05-0x0f
        
        // Values
        INT32             = 0x10,
        STR32             = 0x11,
        STR16             = 0x12,
        BUF32             = 0x13,
        BUF16             = 0x14,
        UNUSED            = 0x15,
        UNDEFINED         = 0x16,
        NULL              = 0x17,
        TRUE              = 0x18,
        FALSE             = 0x19,
        NUMBER            = 0x1A,
        OBJECT            = 0x1B,
        POINTER           = 0x1C,
        LIGHTFUNC         = 0x1D,
        HEAPPTR           = 0x1E,

        // Variable-length strings and ints
        STRV_MIN          = 0x60,
        STRV_MAX          = 0x7F,
        INTV_SM_MIN       = 0x80,
        INTV_SM_MAX       = 0xBF,
        INTV_LRG_MIN      = 0xC0,
        INTV_LRG_MAX      = 0xFF
    }

    export enum NotifyType
    {
        STATUS    = 0x01,
        PRINT     = 0x02,
        ALERT     = 0x03,
        LOG       = 0x04,
        THROW     = 0x05,
        DETACHING = 0x06,
        APP_MSG   = 0x07    // Application-specific notification. Added on v1.5.0
    }

    /// Commands initiated by the client ( our end )
    export enum CmdType
    {
        BASICINFO           = 0x10,
        TRIGGERSTATUS       = 0x11,
        PAUSE               = 0x12,
        RESUME              = 0x13,
        STEPINTO            = 0x14,
        STEPOVER            = 0x15,
        STEPOUT             = 0x16,
        LISTBREAK           = 0x17,
        ADDBREAK            = 0x18,
        DELBREAK            = 0x19,
        GETVAR              = 0x1a,
        PUTVAR              = 0x1b,
        GETCALLSTACK        = 0x1c,
        GETLOCALS           = 0x1d,
        EVAL                = 0x1e,
        DETACH              = 0x1f,
        DUMPHEAP            = 0x20,
        GETBYTECODE         = 0x21,
        APPCOMMAND          = 0x22,
        GETHEAPOBJINFO      = 0x23,
        GETOBJPROPDESC      = 0x24,
        GETOBJPROPDESCRANGE = 0x25,
        GETSCOPEKEYS        = 0x7F,  // Musashi-specific
    }

    export enum PropDescFlag
    {
        ATTR_WRITABLE     = 0x01,
        ATTR_ENUMERABLE   = 0x02,
        ATTR_CONFIGURABLE = 0x04,
        ATTR_ACCESSOR     = 0x08,
        VIRTUAL           = 0x10,
        INTERNAL          = 0x100
    }

    export enum ErrorType
    {
        UNKNOWN       = 0x00,
        UNSUPPORTED   = 0x01,
        TOOMANY       = 0x02,
        NOTFOUND      = 0x03,
        APP_ERROR     = 0x04
    }
        
    export var ERR_TYPE_MAP:Array<string> = [
        "Unknown or unspecified error",
        "Unsupported command",
        "Too many",
        "Not found",
        "Application error (e.g. AppRequest-related error)"
    ];
    
    /// Primitive DValue kinds
    export enum DValKind
    {
        EOM = 0,
        REQ ,
        REP ,
        ERR ,
        NFY ,
        int ,
        str ,
        buf ,
        ptr ,
        tval,
        unused,
        undef,
        nul,
        num,
    }

    export enum TValueType
    {
        UNUSED,
        UNDEFINED,
        NULL,
        BOOLEAN,
        NUMBER,
        STRING,
        BUFFER,
        OBJECT,
        POINTER,
        LIGHTFUNC
    }

    // See DUK_HOBJECT_CLASS_* in duk_hobject.h
    export enum HObjectClassID
    {
        UNUSED               = 0,
        ARGUMENTS            = 1,
        ARRAY                = 2,
        BOOLEAN              = 3,
        DATE                 = 4,
        ERROR                = 5,
        FUNCTION             = 6,
        JSON                 = 7,
        MATH                 = 8,
        NUMBER               = 9,
        OBJECT               = 10,
        REGEXP               = 11,
        STRING               = 12,
        GLOBAL               = 13,
        OBJENV               = 14,
        DECENV               = 15,
        BUFFER               = 16,
        POINTER              = 17,
        THREAD               = 18,
        ARRAYBUFFER          = 19,
        DATAVIEW             = 20,
        INT8ARRAY            = 21,
        UINT8ARRAY           = 22,
        UINT8CLAMPEDARRAY    = 23,
        INT16ARRAY           = 24,
        UINT16ARRAY          = 25,
        INT32ARRAY           = 26,
        UINT32ARRAY          = 27,
        FLOAT32ARRAY         = 28,
        FLOAT64ARRAY         = 29,

        _MAX_ITEMS
    }

    export var HObjectClassNames:Array<string> = [
        "UNUSED"             ,
        "Arguments"          ,
        "Array"              ,
        "Boolean"            ,
        "Date"               ,
        "Error"              ,
        "Function"           ,
        "JSON"               ,
        "Math"               ,
        "Number"             ,
        "Object"             ,
        "RegExp"             ,
        "String"             ,
        "global"             ,
        "ObjEnv"             ,
        "DecEnv"             ,
        "Buffer"             ,
        "Pointer"            ,
        "Thread"             ,
        "ArrayBuffer"        ,
        "DataView"           ,
        "Int8Array"          ,
        "Uint8Array"         ,
        "Uint8ClampedArray"  ,
        "Int16Array"         ,
        "Uint16Array"        ,
        "Int32Array"         ,
        "Uint32Array"        ,
        "Float32Array"       ,
        "Float64Array"
    ];

    export class TValPointer
    {
        public size  :number;   // Expected to be 4 or 8
        public lopart:number;   // For 32-bit debug target, this part is used only
        public hipart:number;   // For 64-bit debug target, append this as the most significant bits to lopart
        
        public constructor( size:number, lopart:number, hipart:number )
        {
            this.size   = size;
            this.lopart = lopart;
            this.hipart = hipart;
        }
        
        public isNull() : boolean
        {
            return this.size == 0;
        }
        
        public static NullPtr() : TValPointer
        {
            return new TValPointer( 0, 0, 0 );
        }
        
        public static TryConvert( obj:any ) : TValPointer
        {
            if( obj instanceof TValPointer )
                return <TValPointer>obj;
            else if( obj instanceof TValObject )
                return (<TValObject>obj).ptr;
            else if( obj instanceof TValLightFunc )
                return (<TValLightFunc>obj).ptr;
            else if( obj instanceof TValue )
                return  TValPointer.TryConvert( (<TValue>obj).val );
            else
                return null;
        }
        
        public toString() : string
        {
            return this.size == 4 ? `0x${this.toPaddedHex(this.lopart)}` :
                    `0x${this.toPaddedHex(this.hipart)}${this.toPaddedHex(this.lopart)}`;
        } 
        
        private toPaddedHex( n:number ) : string 
        {
            let s = n.toString( 16 );
            let z = "";
            let c = 8 - s.length;
            
            for( let i=0; i < c; i++ )
                z += '0';
            
            return z + s;
        }
    }

    export class TValObject
    {
        public classID : number;
        public ptr     : TValPointer;
        
        public constructor( classID:number, ptr:TValPointer )
        {
            this.classID = classID;
            this.ptr     = ptr;
        }
        
        public toString() : string
        {
            return `{ cls: ${this.classID}, ptr: ${this.ptr.toString()} }`;
        }
    }

    export class TValLightFunc
    {
        public flags : number;
        public ptr   : TValPointer;
        
        public constructor( flags:number, ptr:TValPointer )
        {
            this.flags = flags;
            this.ptr   = ptr;
        }
        
        public toString() : string
        {
            return `{ flags: ${this.flags}, ptr: ${this.ptr.toString()} }`;
        }
    }

    export type TValueUnion = boolean | number | string | TValPointer | TValObject | TValLightFunc | Buffer;
    
    export class TValue
    {
        type : TValueType ;
        val  : TValueUnion;
        
        constructor( type:TValueType, val:TValueUnion )
        {
            this.type = type;
            this.val  = val ;
        }
        
        public static Unused() : TValue
        {
            return new TValue( TValueType.UNUSED, undefined );
        }
        
        public static Undefined() : TValue
        {
            return new TValue( TValueType.UNDEFINED, undefined );
        }
        
        public static Null() : TValue
        {
            return new TValue( TValueType.NULL, null );
        }
        
        public static Bool( val:boolean ) : TValue
        {
            return new TValue( TValueType.BOOLEAN, val );
        }
        
        public static Number( val:number ) : TValue
        {
            return new TValue( TValueType.NUMBER, val );
        }
        
        public static String( val:string ) : TValue
        {
            return new TValue( TValueType.STRING, val );
        }
        
        public static Buffer( val:Buffer ) : TValue
        {
            return new TValue( TValueType.BUFFER, val );
        }
        
        public static Object( classID:number, ptr:TValPointer ) : TValue
        {
            return new TValue( TValueType.OBJECT, 
                              new TValObject( classID, ptr) );
        }
        
        public static Pointer( ptr:TValPointer ) : TValue
        {
            return new TValue( TValueType.POINTER, ptr );
        }
        
        public static LightFunc( val:TValLightFunc ) : TValue
        {
            return new TValue( TValueType.LIGHTFUNC, val );
        }
    }
    
    export type DValueUnion = boolean | number | string | Buffer | TValPointer | TValObject | TValLightFunc;

    export class DValue
    {
        public type :DValKind;
        public value:DValueUnion;
        
        constructor( type:DValKind, value:DValueUnion )
        {
            this.type  = type ;
            this.value = value;
        }
    }
    
    export class Property
    {
        flags :number;
        key   :string | number;
        value :DValueUnion;
        getter:TValObject;
        setter:TValObject;


        public get isAccessor() : boolean
        {
            return ( this.flags & PropDescFlag.ATTR_ACCESSOR) != 0; 
        }
    }

//} // End NS
