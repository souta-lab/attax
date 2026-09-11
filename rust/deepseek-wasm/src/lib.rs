//! wasm32 cdylib wrapper for the Rust DeepSeek v2 fighter (`hoiko-deepseek`).
//!
//! Mirrors `rust/hoiko-wasm`: the engine is pure and deterministic, verified
//! natively (`cargo test`), and only compiled to wasm for shipping. The host
//! allocates an input/output block in linear memory and calls `ds_best_move`
//! once per move. All `unsafe` is confined to this FFI shim; `abi::run_best_move`
//! is safe and carries the documented `#[repr(C)]` layout.

mod abi;

pub use abi::{DsInput, DsOutput, run_best_move};

#[unsafe(no_mangle)]
pub extern "C" fn ds_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must originate from `ds_alloc(size)` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ds_dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, size));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ds_input_size() -> usize {
    core::mem::size_of::<DsInput>()
}

#[unsafe(no_mangle)]
pub extern "C" fn ds_output_size() -> usize {
    core::mem::size_of::<DsOutput>()
}

/// One DeepSeek v2 search per move. `in_ptr`/`out_ptr` point at linear-memory
/// blocks of `ds_input_size()` / `ds_output_size()` bytes laid out exactly as
/// `abi::DsInput` / `abi::DsOutput`.
///
/// Returns 1 when a move was produced (and `out` is filled), else 0.
///
/// # Safety
/// `in_ptr` must point to a valid, initialised `DsInput` and `out_ptr` to a
/// writable `DsOutput`; neither may overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ds_best_move(in_ptr: *const DsInput, out_ptr: *mut DsOutput) -> i32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }
    let input = unsafe { &*in_ptr };
    let out = unsafe { &mut *out_ptr };
    run_best_move(input, out)
}
