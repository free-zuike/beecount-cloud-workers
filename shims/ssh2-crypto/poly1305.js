"use strict";`nmodule.exports = function() {`n  return {`n    HEAPU8: { buffer: new ArrayBuffer(0) },`n    _malloc: () => 0,`n    _free: () => {}`n  };`n};
