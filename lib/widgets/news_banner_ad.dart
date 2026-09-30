import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import '../config/ad_mob_config.dart';
import '../models/ad_identity.dart';
import '../services/ad_consent_service.dart';
import '../services/monetization_analytics_service.dart';

class NewsBannerAd extends StatefulWidget {
  @visibleForTesting
  final BannerAd Function(AdSize, BannerAdListener)? adFactory;
  @visibleForTesting
  final Future<AdSize?> Function(int)? sizeLoader;
  @visibleForTesting
  final Future<bool> Function()? consentCheck;
  const NewsBannerAd({
    super.key,
    this.adFactory,
    this.sizeLoader,
    this.consentCheck,
  });
  @override
  State<NewsBannerAd> createState() => _NewsBannerAdState();
}

class _NewsBannerAdState extends State<NewsBannerAd> {
  BannerAd? _ad;
  AdSize? _size;
  double? _width;
  bool _checking = false;
  bool _requested = false;
  bool _loaded = false;
  bool _paid = false;
  final _adWidgetKey = GlobalKey();
  final _identity = AdIdentity(
    adFormat: 'banner',
    screen: 'news',
    placement: 'fixedBanner',
  );

  @override
  void initState() {
    super.initState();
    MonetizationAnalyticsService.instance.ad('ad_slot_created', _identity);
    AdConsentService.instance.addListener(_load);
  }

  Future<void> _load() async {
    if (_requested ||
        _checking ||
        _width == null ||
        (!AdMobConfig.supported && widget.adFactory == null) ||
        AdMobConfig.unitId(AdUnit.newsBanner).isEmpty) {
      return;
    }
    _checking = true;
    try {
      final allowed = await _allowed();
      if (!allowed || !mounted) return;
      _requested = true;

      final size =
          await (widget.sizeLoader?.call(_width!.floor()) ??
              // ignore: deprecated_member_use
              AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(
                _width!.floor(),
              ));

      if (!mounted || size == null) {
        return;
      }

      if (mounted) {
        setState(() {
          _size = size;
        });
      }

      // 実アプリ（adFactoryなし）ではデバッグ時に実Adをロードせずプレースホルダー表示へ進める。
      // テスト注入用ファクトリがある場合はそのままAd生成経路へ進める。
      if (AdMobConfig.usePlaceholder && widget.adFactory == null) {
        setState(() {
          _loaded = true;
        });
        return;
      }

      MonetizationAnalyticsService.instance.ad('ad_load_requested', _identity);

      final listener = BannerAdListener(
        onAdLoaded: (_) {
          if (!mounted) return;
          MonetizationAnalyticsService.instance.ad('ad_loaded', _identity);
          setState(() {
            _loaded = true;
          });
        },
        onAdFailedToLoad: (ad, error) {
          MonetizationAnalyticsService.instance.ad(
            'ad_load_failed',
            _identity,
            {'errorCode': error.code},
          );
          ad.dispose();
          _ad = null;
          if (mounted) {
            setState(() {
              _loaded = false;
            });
          }
        },
        onAdImpression: (_) => MonetizationAnalyticsService.instance.ad(
          'ad_impression',
          _identity,
        ),
        onPaidEvent: (_, value, precision, currency) {
          if (_paid) return;
          _paid = true;
          MonetizationAnalyticsService.instance.ad('ad_paid', _identity, {
            'valueMicros': value,
            'precision': precision.name,
            'currency': currency,
          });
        },
      );

      final ad =
          widget.adFactory?.call(size, listener) ??
          BannerAd(
            adUnitId: AdMobConfig.unitId(AdUnit.newsBanner),
            size: size,
            request: const AdRequest(),
            listener: listener,
          );
      _ad = ad;
      await ad.load();
    } catch (e) {
      MonetizationAnalyticsService.instance.ad('ad_load_failed', _identity, {
        'errorCode': 'platform_error',
      });
      _ad?.dispose();
      _ad = null;
    } finally {
      _checking = false;
    }
  }

  Future<bool> _allowed() =>
      widget.consentCheck?.call() ?? AdConsentService.instance.requestAllowed();

  @override
  Widget build(BuildContext context) {
    final double reservedHeight =
        _size?.height.toDouble() ?? AdMobConfig.bannerReservedHeight;

    return SizedBox(
      height: reservedHeight,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth > 0) {
            if (_width != constraints.maxWidth) {
              _width = constraints.maxWidth;
            }
          }

          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) unawaited(_load());
          });
          return Align(
            alignment: Alignment.bottomCenter,
            child:
                _loaded &&
                    (AdMobConfig.usePlaceholder ||
                        (_ad != null &&
                            _size != null &&
                            _size!.width <= constraints.maxWidth))
                ? SizedBox(
                    width: _size?.width.toDouble() ?? constraints.maxWidth,
                    height: _size?.height.toDouble() ?? reservedHeight,
                    child: AdMobConfig.usePlaceholder
                        ? Container(
                            color: Colors.grey.shade200,
                            alignment: Alignment.center,
                            child: const Text(
                              '広告枠 [Banner]',
                              style: TextStyle(
                                fontSize: 10,
                                color: Colors.grey,
                              ),
                            ),
                          )
                        : AdWidget(key: _adWidgetKey, ad: _ad!),
                  )
                : null,
          );
        },
      ),
    );
  }

  @override
  void dispose() {
    AdConsentService.instance.removeListener(_load);
    _ad?.dispose();
    super.dispose();
  }
}
