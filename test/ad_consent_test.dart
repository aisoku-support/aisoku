import 'package:flutter_test/flutter_test.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';
import 'package:news_app/services/ad_consent_service.dart';

class FakeConsent extends ConsentInformation {
  bool allowed = false;
  int updates = 0;
  late void Function() success;
  late void Function(FormError) failure;
  @override
  void requestConsentInfoUpdate(
    ConsentRequestParameters params,
    void Function() onSuccess,
    void Function(FormError) onFailure,
  ) {
    updates++;
    success = onSuccess;
    failure = onFailure;
  }

  @override
  Future<bool> canRequestAds() async => allowed;
  @override
  Future<PrivacyOptionsRequirementStatus>
  getPrivacyOptionsRequirementStatus() async =>
      PrivacyOptionsRequirementStatus.required;
  @override
  Future<ConsentStatus> getConsentStatus() async => ConsentStatus.unknown;
  @override
  Future<bool> isConsentFormAvailable() async => true;
  @override
  Future<void> reset() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('UMP false gates ads; previous and current consent callbacks initialize once', () async {
    final consent = FakeConsent();
    int initialized = 0;
    late void Function(FormError?) finishForm;
    final service = AdConsentService(
      consent: consent,
      initializeAds: () async {
        initialized++;
      },
      requiredForm: (callback) {
        finishForm = callback;
      },
    );
    service.start();
    service.start();
    await Future<void>.delayed(Duration.zero);
    expect(consent.updates, 1);
    expect(await service.requestAllowed(), isFalse);
    expect(initialized, 0);
    consent.success();
    consent.allowed = true;
    finishForm(null);
    consent.failure(FormError(errorCode: 1, message: 'test'));
    await Future<void>.delayed(Duration.zero);
    expect(initialized, 1);
    expect(await service.requestAllowed(), isTrue);
    expect(service.privacyOptionsRequired, isTrue);
    service.dispose();
  });

  test(
    'privacy form blocks new requests and UMP revocation is authoritative',
    () async {
      final consent = FakeConsent()..allowed = true;
      late void Function(FormError?) finishPrivacy;
      final service = AdConsentService(
        consent: consent,
        initializeAds: () async {},
        requiredForm: (callback) {
          callback(null);
        },
        privacyForm: (callback) {
          finishPrivacy = callback;
        },
      );
      service.start();
      await Future<void>.delayed(Duration.zero);
      expect(await service.requestAllowed(), isTrue);
      final showing = service.showPrivacyOptions();
      expect(await service.requestAllowed(), isFalse);
      consent.allowed = false;
      finishPrivacy(null);
      await showing;
      expect(await service.requestAllowed(), isFalse);
      service.dispose();
    },
  );
}
