import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import '../config/ad_mob_config.dart';
import '../models/ad_identity.dart';
import 'ad_consent_service.dart';
import 'monetization_analytics_service.dart';

enum NativeSlotState { reserved, loading, loaded, failed, disposed }

typedef NativeAdCreator = NativeAd Function(
  NativeAdListener listener,
  Map<String, Object> options,
);

class NativeAdSlot extends ChangeNotifier {
  final AdIdentity identity;
  final AdUnit unit;
  final NativeAdCreator? createAd;
  final Future<bool> Function()? consentCheck;
  final void Function(String, AdIdentity, Map<String, Object?>)? eventRecorder;
  NativeSlotState state = NativeSlotState.reserved;
  NativeAd? ad;
  bool hasEnteredViewport = false;
  bool _checking = false;
  bool _paid = false;
  double height;
  double? _width;
  bool _wanted = false;
  static const _channel = MethodChannel('news_app/native_ads');
  static final _slots = <String, NativeAdSlot>{};
  static bool _channelInstalled = false;

  int _usageCount = 0;
  Timer? _unloadTimer;
  bool _isUnloading = false;

  NativeAdSlot({
    required this.identity,
    required this.unit,
    this.createAd,
    this.consentCheck,
    this.eventRecorder,
  }) : height = unit == AdUnit.newsNative ? AdMobConfig.newsNativeHeight : 100 {
    _record('ad_slot_created');
    AdConsentService.instance.addListener(_consentChanged);
  }

  void incrementUsage() {
    _usageCount++;
    _unloadTimer?.cancel();
    _unloadTimer = null;
    _isUnloading = false;
  }

  void decrementUsage() {
    _usageCount--;
    if (_usageCount <= 0) {
      _usageCount = 0;
      _unloadTimer?.cancel();
      // Keep ad for 10s after it's scrolled out to avoid frequent reloads.
      _unloadTimer = Timer(const Duration(seconds: 10), () {
        if (_usageCount <= 0) {
          if (state == NativeSlotState.loaded) {
            unload(reason: 'unused');
          } else if (state == NativeSlotState.loading) {
            _isUnloading = true;
          }
        }
      });
    }
  }

  void _record(String event, [Map<String, Object?> extra = const {}]) {
    if (eventRecorder != null) {
      eventRecorder!(event, identity, extra);
    } else {
      MonetizationAnalyticsService.instance.ad(event, identity, extra);
    }
  }

  void linkLocalGeneration(String id) {
    identity.localGenerationId = id;
    _record('ad_link_updated');
  }

  void _consentChanged() {
    if (_wanted && _width != null) unawaited(load(_width!, reason: 'consent'));
  }

  Future<void> load(double width, {required String reason}) async {
    _wanted = true;
    _width = width;
    if (state != NativeSlotState.reserved || _checking || width <= 0) return;
    if (createAd == null &&
        (!AdMobConfig.supported || AdMobConfig.unitId(unit).isEmpty)) {
      return;
    }
    _checking = true;
    _isUnloading = false;
    try {
      final allowed =
          await (consentCheck?.call() ??
              AdConsentService.instance.requestAllowed());
      if (!allowed || state != NativeSlotState.reserved) return;

      state = NativeSlotState.loading;
      _record('ad_load_requested');

      // 実アプリ（createAdなし）ではデバッグ時に実Adをロードせず予約領域のまま完了させる。
      // テスト注入用ファクトリがある場合はそのままAd生成経路へ進める。
      if (AdMobConfig.usePlaceholder && createAd == null) {
        state = NativeSlotState.loaded;
        notifyListeners();
        return;
      }

      final listener = NativeAdListener(
        onAdLoaded: (_) {
          final isD = state == NativeSlotState.disposed;
          final isU = _isUnloading || (isD == false && _usageCount <= 0);

          if (isD || isU) {
            _releaseAd(
              reason: isD ? 'lateLoadedCallback' : 'unusedWhileLoading',
            );
            if (!isD) {
              state = NativeSlotState.reserved;
              _isUnloading = false;
            }
            return;
          }
          if (state != NativeSlotState.loading) return;
          state = NativeSlotState.loaded;
          _record('ad_loaded');
          notifyListeners();
        },
        onAdFailedToLoad: (_, error) {
          final isD = state == NativeSlotState.disposed;
          if (isD) {
            _releaseAd(reason: 'lateFailedCallback');
            return;
          }
          _fail(error.code.toString());
        },
        onAdImpression: (_) {
          if (state == NativeSlotState.loaded) _record('ad_impression');
        },
        onPaidEvent: (_, valueMicros, precision, currencyCode) {
          if (_paid ||
              state == NativeSlotState.disposed ||
              state == NativeSlotState.failed) {
            return;
          }
          _paid = true;
          _record('ad_paid', {
            'valueMicros': valueMicros,
            'currency': currencyCode,
            'precision': precision.name,
          });
        },
      );
      final options = <String, Object>{
        'adInstanceId': identity.adInstanceId,
        'width': width,
      };
      if (createAd == null) {
        if (!_channelInstalled) {
          _channelInstalled = true;
          _channel.setMethodCallHandler((call) async {
            final args = Map<String, dynamic>.from(call.arguments as Map);
            final slot = _slots[args['adInstanceId']];
            if (slot == null || slot.state == NativeSlotState.disposed) return;
            if (call.method == 'unsupportedVideo') {
              slot._fail('unsupported_video');
            } else if (call.method == 'invalidLayout') {
              slot._fail('invalid_layout');
            } else if (call.method == 'measuredHeight') {
              slot.height = (args['height'] as num).toDouble();
              slot.notifyListeners();
            }
          });
        }
        _slots[identity.adInstanceId] = this;
      }
      ad =
          createAd?.call(listener, options) ??
          NativeAd(
            adUnitId: AdMobConfig.unitId(unit),
            factoryId: unit == AdUnit.newsNative
                ? 'newsNativeFactory'
                : 'threadNativeFactory',
            request: const AdRequest(),
            listener: listener,
            nativeAdOptions: NativeAdOptions(
              adChoicesPlacement: AdChoicesPlacement.topRightCorner,
            ),
            customOptions: options,
          );
      await ad!.load();
    } catch (_) {
      if (state == NativeSlotState.loading) {
        _fail('platform_error');
      }
    } finally {
      _checking = false;
    }
  }

  void _fail(String code) {
    if (state == NativeSlotState.disposed || state == NativeSlotState.failed) {
      return;
    }
    state = NativeSlotState.failed;
    _record('ad_load_failed', {'errorCode': code});
    _releaseAd(reason: 'loadFailure');
    notifyListeners();
  }

  void unload({required String reason}) {
    if (state != NativeSlotState.loaded || ad == null) return;
    _releaseAd(reason: reason);
    state = NativeSlotState.reserved;
    _isUnloading = false;
    notifyListeners();
  }

  void _releaseAd({required String reason}) {
    final old = ad;
    ad = null;
    if (old != null) {
      unawaited(old.dispose());
    }
  }

  @override
  void dispose() {
    if (state == NativeSlotState.disposed) return;
    _unloadTimer?.cancel();
    _unloadTimer = null;
    final wasLoading = state == NativeSlotState.loading;
    state = NativeSlotState.disposed;
    _slots.remove(identity.adInstanceId);
    AdConsentService.instance.removeListener(_consentChanged);
    if (!wasLoading) _releaseAd(reason: 'slotDispose');
    super.dispose();
  }
}
