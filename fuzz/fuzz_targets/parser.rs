#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(content) = std::str::from_utf8(data) {
        let _ = okfx_parser::parse_markdown_document("fuzz.md", content, "fuzz");
    }
});
