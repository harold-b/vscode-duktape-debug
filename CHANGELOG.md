## 0.3.0
    - Support for duktape v2.*.* in addtion to v.1.5+.
    - Support for files in subfolders (thanks @shaddockh). See: https://github.com/harold-b/vscode-duktape-debug/pull/21
    - Update to current extension vscode API. See: https://github.com/harold-b/vscode-duktape-debug/issues/19

## 0.2.13
    - Hotfix for github issues #10 & #11.

## 0.2.11
    - Updated documentation.

## 0.2.9
    - Fixed 64-bit pointers being written incorrectly. This would cause a crash in the target host.

## 0.2.8
    - Fixed sending empty eval expressions.

## 0.2.7

    - 'stopOnEntry' works properly now. 

## 0.2.6

    - AppMessage notification is ignored, instead of throwing an exception.
    - Added 'debugLog' config option to log all traffic.
    - Fixed none-transpiled files not having their breakpoints properly set.
