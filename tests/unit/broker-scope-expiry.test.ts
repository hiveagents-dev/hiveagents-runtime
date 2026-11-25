import { expect, it } from 'vitest';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
it('expires only interactions for the retired native session', () => {
 const broker=new InteractionBroker({provider:'codex',epoch:'one'});
 const add=(sessionId:string)=>broker.register({method:'item/tool/call',sessionId,payload:{},availableDecisions:['fulfill'],settle:async()=>{}});
 const first=add('one'), second=add('two');
 broker.expireScope('one');
 expect(first.signal.aborted).toBe(true);expect(second.signal.aborted).toBe(false);expect(broker.size).toBe(1);
});
