# wat-modules

`SourceModule` identifies an owning source module, generated file, private symbol prefix and exported symbols. `WatLayout` records declaration order and UTF-16 offsets for lossless reconstruction. `modularWat` separates declarations by ownership, verifies paths and rejects any change to the original backend WAT when reassembled.
