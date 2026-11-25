import {describe,expect,it,vi} from 'vitest';
import {ExecutionHaltedError,isExecutionHalted,rethrowExecutionHalt} from '../../src/public/execution-halt.js';

describe('nominal execution halt propagation',()=>{
 it('forces non-retryable context and retains the private original cause',()=>{
  const cause=Error('synthetic persistence failure');const error=new ExecutionHaltedError({provider:'codex'},{cause});
  expect(error.code).toBe('EXECUTION_HALTED');expect(error.context.retryable).toBe(false);expect(error.cause).toBe(cause);
  expect(isExecutionHalted(error)).toBe(true);expect(()=>rethrowExecutionHalt(error)).toThrow(error);
 });
 it('recognizes genuine nested aggregates/causes while preserving the identical outer error',()=>{
  const halt=new ExecutionHaltedError();const outer=new AggregateError([Error('first'),new Error('cleanup',{cause:new AggregateError([halt])})]);
  expect(isExecutionHalted(outer)).toBe(true);try{rethrowExecutionHalt(outer);throw Error('missing halt')}catch(error){expect(error).toBe(outer)}
 });
 it('does not trust plain codes, fabricated prototypes, proxies or accessor-backed fields',()=>{
  const read=vi.fn(()=>{throw Error('untrusted accessor invoked')});const accessor=new Error('untrusted');Object.defineProperty(accessor,'cause',{get:read});
  const aggregate=new AggregateError([]);Object.defineProperty(aggregate,'errors',{get:read});
  const proxy=new Proxy(new Error('untrusted'),{get:read,getPrototypeOf:read,getOwnPropertyDescriptor:read});
  for(const error of [{code:'EXECUTION_HALTED'},Object.create(ExecutionHaltedError.prototype),proxy,accessor,aggregate]){
   expect(isExecutionHalted(error)).toBe(false);expect(()=>rethrowExecutionHalt(error)).not.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
 });
 it('bounds cycles and conservatively halts an oversized genuine native error graph',()=>{
  const cyclic=new Error('cycle');Object.defineProperty(cyclic,'cause',{value:cyclic});expect(isExecutionHalted(cyclic)).toBe(false);
  const huge=new AggregateError(Array.from({length:1000},()=>new Error('synthetic')));
  expect(isExecutionHalted(huge)).toBe(true);
  try{rethrowExecutionHalt(huge);throw Error('missing graph fuse')}catch(error){expect(error).toBeInstanceOf(ExecutionHaltedError);expect((error as Error).cause).toBe(huge)}
 });
});
