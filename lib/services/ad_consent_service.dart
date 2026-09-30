import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import '../config/ad_mob_config.dart';

class AdConsentService extends ChangeNotifier {
  static final instance = AdConsentService();
  bool canLoadAds = false;
  bool privacyOptionsRequired = false;
  bool _started = false;
  bool _showingPrivacy = false;
  Future<void>? _initialization;
  final ConsentInformation _consent;
  final Future<void> Function() _initializeAds;
  final void Function(void Function(FormError?)) _requiredForm;
  final void Function(void Function(FormError?)) _privacyForm;

  AdConsentService({
    ConsentInformation? consent,
    Future<void> Function()? initializeAds,
    void Function(void Function(FormError?))? requiredForm,
    void Function(void Function(FormError?))? privacyForm,
  }) : _consent = consent ?? ConsentInformation.instance,
       _initializeAds =
           initializeAds ??
           (() => MobileAds.instance.initialize().then((_) {})),
       _requiredForm =
           requiredForm ?? ConsentForm.loadAndShowConsentFormIfRequired,
       _privacyForm = privacyForm ?? ConsentForm.showPrivacyOptionsForm;

  void start() {
    if (_started || !AdMobConfig.supported) return;
    _started = true;
    _consent.requestConsentInfoUpdate(
      ConsentRequestParameters(),
      () {
        _requiredForm((_) {
          unawaited(_refresh());
        });
      },
      (_) {
        unawaited(_refresh());
      },
    );
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    try {
      final status = await _consent.getPrivacyOptionsRequirementStatus();
      privacyOptionsRequired =
          status == PrivacyOptionsRequirementStatus.required;
      final allowed = await _consent.canRequestAds();
      if (allowed) {
        _initialization ??= _initializeAds();
        await _initialization;
      }
      canLoadAds = allowed && !_showingPrivacy;
      notifyListeners();
    } catch (_) {
      canLoadAds = false;
      notifyListeners();
    }
  }

  Future<bool> requestAllowed() async {
    if (!canLoadAds) return false;
    return _consent.canRequestAds();
  }

  Future<FormError?> showPrivacyOptions() async {
    if (_showingPrivacy || !privacyOptionsRequired) return null;
    _showingPrivacy = true;
    canLoadAds = false;
    notifyListeners();
    final completion = Completer<FormError?>();
    _privacyForm((error) {
      completion.complete(error);
    });
    final error = await completion.future;
    _showingPrivacy = false;
    await _refresh();
    return error;
  }
}
