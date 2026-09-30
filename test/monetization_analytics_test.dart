import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/ad_identity.dart';
import 'package:news_app/services/monetization_analytics_service.dart';

void main() {
  test('outbox survives failed delivery/restart with same event ID and immutable snapshot', () async {
    String? storage;
    final delivered = <Map<String, dynamic>>[];
    final service = MonetizationAnalyticsService(
      readStorage: () async => storage,
      writeStorage: (value) async {
        storage = value;
      },
      sendBatch: (_) async {
        throw Exception('offline');
      },
    );
    final data = <String, Object?>{'success': null};
    service.record('generation_started', newMeasurementId(), data);
    data['success'] = true;
    await service.start();
    final before = (jsonDecode(storage!) as List).single as Map;
    expect((before['data'] as Map)['success'], isNull);
    service.dispose();
    final resumed = MonetizationAnalyticsService(
      readStorage: () async => storage,
      writeStorage: (value) async {
        storage = value;
      },
      sendBatch: (batch) async {
        delivered.addAll(batch);
      },
    );
    await resumed.start();
    expect(delivered.single['eventId'], before['eventId']);
    expect(jsonDecode(storage!), isEmpty);
    resumed.dispose();
  });
}
