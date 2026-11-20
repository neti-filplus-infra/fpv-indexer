# Changelog

## [2.2.0](https://github.com/fidlabs/fpv-indexer/compare/v2.1.1...v2.2.0) (2026-11-20)


### Features

* add json logging and indexer profiling ([#59](https://github.com/fidlabs/fpv-indexer/issues/59)) ([4f71012](https://github.com/fidlabs/fpv-indexer/commit/4f7101285fe0c47bb73875558a0fafce29c84789))

## [2.1.1](https://github.com/fidlabs/fpv-indexer/compare/v2.1.0...v2.1.1) (2026-11-19)


### Bug Fixes

* wait for concurrent indexers to finish before retry on error ([#58](https://github.com/fidlabs/fpv-indexer/issues/58)) ([a6fab2a](https://github.com/fidlabs/fpv-indexer/commit/a6fab2ab21054598dc0cd8c262ecac0b6528fee3))


### Documentation

* update instances URLs ([#56](https://github.com/fidlabs/fpv-indexer/issues/56)) ([a140ac0](https://github.com/fidlabs/fpv-indexer/commit/a140ac0a2d3f356ceceaa889d21bcd05998325ae))

## [2.1.0](https://github.com/fidlabs/fpv-indexer/compare/v2.0.1...v2.1.0) (2026-11-17)


### Features

* use dynamic batch size based on timeouts count ([#54](https://github.com/fidlabs/fpv-indexer/issues/54)) ([968b568](https://github.com/fidlabs/fpv-indexer/commit/968b568aed515e75334303fb7a9b8b7c61d397a5))

## [2.0.1](https://github.com/fidlabs/fpv-indexer/compare/v2.0.0...v2.0.1) (2026-11-17)


### Bug Fixes

* properly cleanup tables on major version change ([#52](https://github.com/fidlabs/fpv-indexer/issues/52)) ([fc89e7e](https://github.com/fidlabs/fpv-indexer/commit/fc89e7e800532ab0af512905ec93f186d3d8f9db))

## [2.0.0](https://github.com/fidlabs/fpv-indexer/compare/v1.1.1...v2.0.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* do min lot checks properly based on prev q auctions count ([#49](https://github.com/fidlabs/fpv-indexer/issues/49))
* prevent volume accrual by removed orchestrators ([#48](https://github.com/fidlabs/fpv-indexer/issues/48))
* make pricing period response shape match changes in #33 ([#46](https://github.com/fidlabs/fpv-indexer/issues/46))
* properly index burnForFees calls made with multicall and/or multisig ([#33](https://github.com/fidlabs/fpv-indexer/issues/33))

### Features

* add unique indices on payments table ([#51](https://github.com/fidlabs/fpv-indexer/issues/51)) ([f071ced](https://github.com/fidlabs/fpv-indexer/commit/f071ced8356b2b876bb1f2a0b8e127f87a93dab2))
* expose registration cutoff in quarter parameters endpoint ([#50](https://github.com/fidlabs/fpv-indexer/issues/50)) ([ba12616](https://github.com/fidlabs/fpv-indexer/commit/ba126169c19a7de8f1c57f9a8a938af895305b50))


### Bug Fixes

* do min lot checks properly based on prev q auctions count ([#49](https://github.com/fidlabs/fpv-indexer/issues/49)) ([2838056](https://github.com/fidlabs/fpv-indexer/commit/2838056b064de2164d6d6c9a1d7c3368787c231d))
* make pricing period response shape match changes in [#33](https://github.com/fidlabs/fpv-indexer/issues/33) ([#46](https://github.com/fidlabs/fpv-indexer/issues/46)) ([96e8284](https://github.com/fidlabs/fpv-indexer/commit/96e8284380d2be6388784eb3aee30d80d631be09))
* prevent volume accrual by removed orchestrators ([#48](https://github.com/fidlabs/fpv-indexer/issues/48)) ([9961ec8](https://github.com/fidlabs/fpv-indexer/commit/9961ec816b75aaf2c8e687828500a90bc0d8b075))
* properly apply min lot checks including floor ([#42](https://github.com/fidlabs/fpv-indexer/issues/42)) ([69cdd99](https://github.com/fidlabs/fpv-indexer/commit/69cdd99b4d5d7fdd9066bd31dc4c00d963f8ee56))
* properly apply stablecoin removals to volume calculation ([#43](https://github.com/fidlabs/fpv-indexer/issues/43)) ([1b6d019](https://github.com/fidlabs/fpv-indexer/commit/1b6d01929fc266ea257e34ba7ebb52c2a7d03c50))
* properly apply whitelists to orchestrators payments query ([#47](https://github.com/fidlabs/fpv-indexer/issues/47)) ([6a70e59](https://github.com/fidlabs/fpv-indexer/commit/6a70e59abae9e794321caa964ff23bf659d034b0))
* properly index burnForFees calls made with multicall and/or multisig ([#33](https://github.com/fidlabs/fpv-indexer/issues/33)) ([c812dc1](https://github.com/fidlabs/fpv-indexer/commit/c812dc1440aa0b53f4644666db5c71fdec1f9aa0))


### CI

* Add release app to works with release-please action ([#44](https://github.com/fidlabs/fpv-indexer/issues/44)) ([aa58807](https://github.com/fidlabs/fpv-indexer/commit/aa5880734a47532efd545e54212d9ad5ef9e96a9))

## [1.1.1](https://github.com/fidlabs/fpv-indexer/compare/v1.1.0...v1.1.1) (2026-11-12)


### Refactoring

* better request and response schema handling ([#26](https://github.com/fidlabs/fpv-indexer/issues/26)) ([51ccf62](https://github.com/fidlabs/fpv-indexer/commit/51ccf62bc324b95b20220a4d0a8dcdd27b28f9f7))


### Maintenance

* **deps-dev:** bump brace-expansion from 5.0.9 to 5.0.13 ([#38](https://github.com/fidlabs/fpv-indexer/issues/38)) ([37cf8ad](https://github.com/fidlabs/fpv-indexer/commit/37cf8adb13d0e0ff70a9ca8fb3d7d9a56a5272f8))
* **deps:** bump @vitest/mocker and vitest ([#35](https://github.com/fidlabs/fpv-indexer/issues/35)) ([cb68b23](https://github.com/fidlabs/fpv-indexer/commit/cb68b23edfe2d78a36d507352806e7b7e56624e2))
* **deps:** bump body-parser from 2.3.0 to 2.4.0 ([#31](https://github.com/fidlabs/fpv-indexer/issues/31)) ([edd518f](https://github.com/fidlabs/fpv-indexer/commit/edd518fd516db76caf26aa8af83cebbc1b9f376c))
* **deps:** bump deepmerge-ts, prisma and @prisma/internals ([#40](https://github.com/fidlabs/fpv-indexer/issues/40)) ([826aac0](https://github.com/fidlabs/fpv-indexer/commit/826aac027926325841ae7954691d942f5b548845))
* **deps:** bump fast-uri from 3.1.7 to 3.1.9 ([#30](https://github.com/fidlabs/fpv-indexer/issues/30)) ([031295c](https://github.com/fidlabs/fpv-indexer/commit/031295c782aaf7c135c8ec6884e4f348f18a046c))
* **deps:** bump follow-redirects from 1.16.0 to 1.16.3 ([#29](https://github.com/fidlabs/fpv-indexer/issues/29)) ([918cacc](https://github.com/fidlabs/fpv-indexer/commit/918cacc1e29e4f98515f168c10ff7d1fe936c6ce))
* **deps:** bump minimatch, @nestjs/cli and typescript-eslint ([#36](https://github.com/fidlabs/fpv-indexer/issues/36)) ([031f471](https://github.com/fidlabs/fpv-indexer/commit/031f47173022ac0a5a2779e677b29e40a71b5151))
* **deps:** bump multer and @nestjs/platform-express ([#27](https://github.com/fidlabs/fpv-indexer/issues/27)) ([4a63abb](https://github.com/fidlabs/fpv-indexer/commit/4a63abb2a27e4c612d3efea8e769e69d361f239a))
* **deps:** bump mysql2 and prisma ([#39](https://github.com/fidlabs/fpv-indexer/issues/39)) ([a812601](https://github.com/fidlabs/fpv-indexer/commit/a8126016e8f8b644562b1996139c0f09e21b9646))
* **deps:** bump qs from 6.16.0 to 6.17.1 ([#28](https://github.com/fidlabs/fpv-indexer/issues/28)) ([f8e5561](https://github.com/fidlabs/fpv-indexer/commit/f8e5561ff2d5df45e149f478a4fd3fe9faa9b4c5))
* **deps:** bump vite from 8.3.0 to 8.3.8 ([#37](https://github.com/fidlabs/fpv-indexer/issues/37)) ([dbf821e](https://github.com/fidlabs/fpv-indexer/commit/dbf821ea6606cdc8220bb73fbdfd625f70d556ee))
* **deps:** bump zod from 4.4.3 to 4.6.7 ([#34](https://github.com/fidlabs/fpv-indexer/issues/34)) ([630435d](https://github.com/fidlabs/fpv-indexer/commit/630435d7e9bca33462a74f53bda82744552b3f0d))

## [1.1.0](https://github.com/fidlabs/fpv-indexer/compare/v1.0.1...v1.1.0) (2026-10-19)


### Features

* split archive and recent node batch block size config ([cc48f95](https://github.com/fidlabs/fpv-indexer/commit/cc48f95cf01be7b9756d263ebf4821d9f569ea6b))


### Documentation

* add mainnet instance URL to README ([a3f5d72](https://github.com/fidlabs/fpv-indexer/commit/a3f5d722c0cdb8275886a0d3d761c94b0283d106))

## [1.0.1](https://github.com/fidlabs/fpv-indexer/compare/v1.0.0...v1.0.1) (2026-10-16)


### CI

* implement release-please ([#20](https://github.com/fidlabs/fpv-indexer/issues/20)) ([463b95a](https://github.com/fidlabs/fpv-indexer/commit/463b95a85d413dc6f2496319bfa2a9976533a375))

## Changelog
