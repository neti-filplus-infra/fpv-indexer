import { parseAbi } from 'viem';

const StreamWeightActorABI = parseAbi([
  'event QuarterlyGateCheckResult(uint64 indexed quarter, bool passed, uint64 steps)',
  'event GateParamsSet(((uint256 base, uint256 stepRatio) target, uint64 steps) params)',
]);

export default StreamWeightActorABI;
