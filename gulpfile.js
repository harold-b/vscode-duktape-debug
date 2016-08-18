
var gulp            = require( "gulp"            );
var path            = require( "path"            );
var del             = require( "del"             );
var ts              = require( "gulp-typescript" );
var sourcemaps      = require( "gulp-sourcemaps" );
var runSequence     = require( "run-sequence"    );
var through         = require( "through2"        );
var uglifyJS        = require( "uglify-js"       );

// Config
var SRC_ROOT      = "./src";
var OUT_DIR       = "./out";
var TS_CFG_PATH   = SRC_ROOT + "/tsconfig.json";
var EXT_OUT_DIR   = "./builds";

// Create TS project
var tsCfg = ts.createProject( TS_CFG_PATH, {
    noEmitOnError : true,
    sortOutput    : true
});


/// Methods
function uglifyOutput( mangle )
{
    return through.obj( function(file, encoding, cb) {

        if( file.isNull() ) 
            return cb( null, file )
        
        var opts = {
            fromString       : true,
            mangle           : mangle,
            sourceRoot       : "../src",
            inSourceMap      : file.sourceMap,
            outSourceMap     : file.basename + ".map"
        };

        if( file.isStream() ) {
            throw new Error( "Build Pipeline: Cannot handle streams." );
        }

        let fstr   = file.contents.toString();
        let inFile = {}
        inFile[file.basename] = file.contents.toString();

        var result = uglifyJS.minify( inFile, opts );
        file.contents  = new Buffer( result.code );
        file.sourceMap = JSON.parse( result.map );
        
        cb( null, file );
    });
}

function preparePipeline( opts )
{
    opts = opts || {
        minify: false,
        mangle: false
    };

    // Compile Typescript
    var tsResult = tsCfg.src()
        .pipe( sourcemaps.init() )
        .pipe( ts( tsCfg ) );
    
    var r = tsResult.js;

    // Minify & mangle
    if( opts.minify )
        r.pipe( uglifyOutput() );

    // Write sourceMaps and output
    r.pipe( sourcemaps.write( ".", {
        includeContent: false, 
        sourceRoot: "../src"
    } ))
    .pipe( gulp.dest( OUT_DIR ) );

    return r;
}

function compile( opts )
{
    return function() { return preparePipeline( opts ); }
}

function packageRelease()
{
    console.log( "Packaging extension..." );

    var copyDirs = [
        "./out"
    ];
}

function buildRelease()
{
    return function() { 
        var pipeline = preparePipeline();//{ minify:true, mangle:true });
        pipeline.on( "end", packageRelease );
        return pipeline; 
    };
}



/// Tasks
gulp.task( "build", compile() );

gulp.task( "build-release", buildRelease() );

gulp.task( "clean", function() {
	return del( [OUT_DIR+"/**"] );
});

gulp.task( "watch", ["build"], function() {
    gulp.watch( "./src/**/*.ts", ["build"] );
});

gulp.task( "lint", function() {
   var tslint      = require( 'gulp-tslint' );
   return gulp.src( SRC_ROOT + "/*.ts" )
            .pipe( tslint() )
            .pipe( tslint.report("verbose") ); 
});