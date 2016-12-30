## 0.2.10
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
