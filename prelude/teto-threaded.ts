// Teto threaded intrinsic prelude selected by baguette.config.json.
// This is kernel configuration, not hard-coded compiler behaviour.
@inline function memorySizeOf(memoryHandle: usize): u32 { return <u32>(memory.size() << 16); }
@inline function fill(memoryHandle: usize, at: u32, size: u32, value: u32): void { memory.fill(at, <u8>value, size); }
@inline function copyMemory(memoryHandle: usize, to: u32, from: u32, size: u32): void { memory.copy(to, from, size); }
@inline function loadU8(memoryHandle: usize, at: u32): u32 { return load<u8>(at); }
@inline function loadI8(memoryHandle: usize, at: u32): i64 { return load<i8>(at); }
@inline function loadU16(memoryHandle: usize, at: u32): u32 { return load<u16>(at); }
@inline function loadI16(memoryHandle: usize, at: u32): i64 { return load<i16>(at); }
@inline function loadU32(memoryHandle: usize, at: u32): u32 { return load<u32>(at); }
@inline function loadI32(memoryHandle: usize, at: u32): i32 { return load<i32>(at); }
@inline function loadU64(memoryHandle: usize, at: u32): u64 { return load<u64>(at); }
@inline function loadI64(memoryHandle: usize, at: u32): i64 { return load<i64>(at); }
@inline function storeU8(memoryHandle: usize, at: u32, value: i64): void { store<u8>(at, value); }
@inline function storeU16(memoryHandle: usize, at: u32, value: i64): void { store<u16>(at, value); }
@inline function storeU32(memoryHandle: usize, at: u32, value: i64): void { store<u32>(at, value); }
@inline function storeI32(memoryHandle: usize, at: u32, value: i32): void { store<i32>(at, value); }
@inline function storeU64(memoryHandle: usize, at: u32, value: i64): void { store<u64>(at, value); }
@inline function storeI64(memoryHandle: usize, at: u32, value: i64): void { store<i64>(at, value); }
@inline function compareExchangeI32(memoryHandle: usize, at: u32, expected: i32, replacement: i32): i32 {
  return atomic.cmpxchg<i32>(at, expected, replacement);
}
@inline function atomicAddI32(memoryHandle: usize, at: u32, value: i32): i32 {
  return atomic.add<i32>(at, value);
}
@inline function atomicStoreI32(memoryHandle: usize, at: u32, value: i32): void {
  atomic.store<i32>(at, value);
}
@inline function atomicLoadI32(memoryHandle: usize, at: u32): i32 {
  return atomic.load<i32>(at);
}
@inline function atomicLoadU64(memoryHandle: usize, at: u32): u64 {
  return atomic.load<u64>(at);
}
@inline function atomicStoreU64(memoryHandle: usize, at: u32, value: u64): void {
  atomic.store<u64>(at, value);
}
@inline function atomicAddU64(memoryHandle: usize, at: u32, value: u64): u64 {
  return atomic.add<u64>(at, value);
}
@inline function word(value: i64): i64 { return value; }
@inline function sx(value: i64, bits: i32): i64 { const shift = 64 - bits; return value << shift >> shift; }
@inline function ux(value: i64): u64 { return <u64>value; }
@inline function u32word(value: i64): u64 { return <u32>value; }
@inline function mulU32(left: u32, right: u32): u32 { return left * right; }
@inline function wordToI32(value: i64): i32 { return <i32>value; }
@inline function wordToU32(value: i64): u32 { return <u32>value; }
@inline function wordToPtr(value: u64): u32 { return value > 0x7fffffff ? 0xffffffff : <u32>value; }
@inline function bitsToF32(value: u64): f32 { return reinterpret<f32>(<i32>value); }
@inline function bitsToF64(value: u64): f64 { return reinterpret<f64>(<i64>value); }
@inline function f32ToBits(value: f64): u64 { return <u32>reinterpret<i32>(<f32>value); }
@inline function f64ToBits(value: f64): u64 { return <u64>reinterpret<i64>(value); }
@inline function roundF32(value: f64): f32 { return <f32>value; }
@inline function floatIsNaN(value: f64): bool { return value != value; }
@inline function floatSqrt(value: f64): f64 { return Math.sqrt(value); }
@inline function floatMin(left: f64, right: f64): f64 { return Math.min(left, right); }
@inline function floatMax(left: f64, right: f64): f64 { return Math.max(left, right); }
@inline function floatTrunc(value: f64): f64 { return Math.trunc(value); }
@inline function floatFloor(value: f64): f64 { return Math.floor(value); }
@inline function floatCeil(value: f64): f64 { return Math.ceil(value); }
@inline function floatToI64(value: f64): i64 { return <i64>value; }
@inline function floatToU64(value: f64): u64 { return <u64>value; }
@inline function wordToFloat(value: i64): f64 { return <f64>value; }
@inline function unsignedWordToFloat(value: u64): f64 { return <f64>value; }

@inline function mulHighUnsigned(left: u64, right: u64): u64 {
  const mask: u64 = 0xffffffff;
  const a0 = left & mask, a1 = left >> 32;
  const b0 = right & mask, b1 = right >> 32;
  let value = a0 * b0;
  const carry = value >> 32;
  value = a1 * b0 + carry;
  const middle = value & mask, high = value >> 32;
  value = a0 * b1 + middle;
  return a1 * b1 + high + (value >> 32);
}

@inline function mulHighSigned(left: i64, right: i64): i64 {
  let high = mulHighUnsigned(<u64>left, <u64>right);
  if (left < 0) high -= <u64>right;
  if (right < 0) high -= <u64>left;
  return <i64>high;
}

@inline function mulHighSignedUnsigned(left: i64, right: u64): i64 {
  let high = mulHighUnsigned(<u64>left, right);
  if (left < 0) high -= right;
  return <i64>high;
}

@inline function divSigned(left: i64, right: i64, bits: i32): i64 {
  const a = sx(left, bits), b = sx(right, bits);
  if (b == 0) return -1;
  const minimum = bits == 32 ? <i64>-2147483648 : <i64>0x8000000000000000;
  if (a == minimum && b == -1) return a;
  return sx(a / b, bits);
}

@inline function divUnsigned(left: u64, right: u64, bits: i32): u64 {
  const a = bits == 32 ? <u64><u32>left : left;
  const b = bits == 32 ? <u64><u32>right : right;
  if (b == 0) return bits == 32 ? <u64>0xffffffff : <u64>-1;
  return bits == 32 ? <u64><u32>(a / b) : a / b;
}

@inline function remSigned(left: i64, right: i64, bits: i32): i64 {
  const a = sx(left, bits), b = sx(right, bits);
  if (b == 0) return a;
  const minimum = bits == 32 ? <i64>-2147483648 : <i64>0x8000000000000000;
  if (a == minimum && b == -1) return 0;
  return sx(a % b, bits);
}

@inline function remUnsigned(left: u64, right: u64, bits: i32): u64 {
  const a = bits == 32 ? <u64><u32>left : left;
  const b = bits == 32 ? <u64><u32>right : right;
  if (b == 0) return a;
  return bits == 32 ? <u64><u32>(a % b) : a % b;
}


// intrinsic module omitted: src/teto/types.ts

