// Shared SFX format constants for the Windows stub and its Deno packer
// (`packAppDirTarZstd` in ../../build-windows-exe.ts).
package main

// Magic trailer both ends agree on. Bumped from AIOSFX01 (a bare zip payload,
// no outer compression) to AIOSFX02 (a zstd-compressed tar, ~20% smaller and
// faster to extract). Keep in sync with src/build/build-windows-exe.ts.
const magic = "AIOSFX02"

type header struct {
	SHA256 string `json:"sha256"`
	Binary string `json:"binary"`
	Arch   string `json:"arch"`
	// Format of the payload that follows the stub: "tar.zstd" (the default) or
	// "zip" (the historical payload, still extractable so a mixed fleet keeps
	// working).
	Format string `json:"format"`
}
