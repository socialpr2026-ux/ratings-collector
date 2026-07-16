# Changelog

Изменения проекта публикуются автоматически через Release Please на основе Conventional Commits.

## [0.3.0](https://github.com/socialpr2026-ux/ratings-collector/compare/v0.2.0...v0.3.0) (2026-07-16)


### Features

* ship Interfox Ratings collection and review workflow ([#6](https://github.com/socialpr2026-ux/ratings-collector/issues/6)) ([ab00e3f](https://github.com/socialpr2026-ux/ratings-collector/commit/ab00e3f3550afecd037c705308bae44347f82fee))


### Bug Fixes

* bind NFapteka reviews by product variant ([#14](https://github.com/socialpr2026-ux/ratings-collector/issues/14)) ([1baf01b](https://github.com/socialpr2026-ux/ratings-collector/commit/1baf01b893269f1fa79ff37ee2e95ec234533388))
* clarify completed partial publication ([#17](https://github.com/socialpr2026-ux/ratings-collector/issues/17)) ([5c0f292](https://github.com/socialpr2026-ux/ratings-collector/commit/5c0f29283735f415902af331a2ef5ff46b887005))
* describe per-brand sheet output ([#8](https://github.com/socialpr2026-ux/ratings-collector/issues/8)) ([6fa53ea](https://github.com/socialpr2026-ux/ratings-collector/commit/6fa53ea2f337ad5d01575d27f7512bd7fe191002))
* harden rating accuracy and product identity ([#11](https://github.com/socialpr2026-ux/ratings-collector/issues/11)) ([c5389fd](https://github.com/socialpr2026-ux/ratings-collector/commit/c5389fd21fedd4bd95e14ee5b6816145326e8180))
* place platform before product link ([#9](https://github.com/socialpr2026-ux/ratings-collector/issues/9)) ([e4ee6f1](https://github.com/socialpr2026-ux/ratings-collector/commit/e4ee6f1687edd5213f6e14851a4f033afbe3103d))
* preserve brand context in partial failures ([#18](https://github.com/socialpr2026-ux/ratings-collector/issues/18)) ([1db575a](https://github.com/socialpr2026-ux/ratings-collector/commit/1db575a772521232066786faff0ae05f56924ec7))
* preserve NFapteka review proof ([#15](https://github.com/socialpr2026-ux/ratings-collector/issues/15)) ([f410944](https://github.com/socialpr2026-ux/ratings-collector/commit/f410944581a93d5f6daed1f8a88e8d7cf895211b))
* preserve Ozon results when one card is blocked ([#20](https://github.com/socialpr2026-ux/ratings-collector/issues/20)) ([57d27ae](https://github.com/socialpr2026-ux/ratings-collector/commit/57d27ae81a94e31a18d827d02a0ab7ce506f7ea5))
* recover Baktoblis collection paths ([8e94816](https://github.com/socialpr2026-ux/ratings-collector/commit/8e948163b6c61246672ac3234b73218d886b6c81))
* recover Cereton sites and allow partial publish ([#16](https://github.com/socialpr2026-ux/ratings-collector/issues/16)) ([436abd7](https://github.com/socialpr2026-ux/ratings-collector/commit/436abd774d1613a6f1da1b7832def36844c1e5db))
* recover large Ozon product queues ([#21](https://github.com/socialpr2026-ux/ratings-collector/issues/21)) ([e4651f6](https://github.com/socialpr2026-ux/ratings-collector/commit/e4651f65b9a06e9cd04976ea7549e02fe533f7e2))
* recover proven live collection paths ([#12](https://github.com/socialpr2026-ux/ratings-collector/issues/12)) ([86fa0f6](https://github.com/socialpr2026-ux/ratings-collector/commit/86fa0f63f7c3c2d324c82dae829bb238fd346879))
* require product-bound review proof ([#10](https://github.com/socialpr2026-ux/ratings-collector/issues/10)) ([f295f35](https://github.com/socialpr2026-ux/ratings-collector/commit/f295f35b931f747b5202e91f1e9ec1ea63e20600))
* stabilize large Ozon brand collections ([#19](https://github.com/socialpr2026-ux/ratings-collector/issues/19)) ([95a9fcd](https://github.com/socialpr2026-ux/ratings-collector/commit/95a9fcdc32884cbc408c3c0ca24593059e2692c6))

## [0.2.0](https://github.com/socialpr2026-ux/ratings-collector/compare/v0.1.0...v0.2.0) (2026-07-14)


### Features

* initial ratings collector ([87f1d52](https://github.com/socialpr2026-ux/ratings-collector/commit/87f1d525998e2df41e0af862b3848656ab2320e7))


### Bug Fixes

* use Node 20 compatible pnpm ([a5a5412](https://github.com/socialpr2026-ux/ratings-collector/commit/a5a54124ebab98297b59f4f3d07385db13c1f6a5))

## 0.1.0

- Первый рабочий облачный выпуск сборщика рейтингов.
- Адаптеры маркетплейсов, отзовиков и аптек.
- Проверка карточек и публикация в Google Таблицы без Google API-ключа.
