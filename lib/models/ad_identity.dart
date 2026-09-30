import 'dart:math';

String newMeasurementId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Logical relationships are independent of SDK impression and revenue.
class AdIdentity {
  final String adInstanceId;
  final String adFormat;
  final String screen;
  final String placement;
  final String? category;
  final int? position;
  final String? adOpportunityId;
  final int? threadAdSequence;
  final String? threadSessionId;
  final String? replacedNormalAdInstanceId;
  final String? sharedGenerationId;
  final String? contributionId;
  String? localGenerationId;

  AdIdentity({
    String? adInstanceId,
    required this.adFormat,
    required this.screen,
    required this.placement,
    this.category,
    this.position,
    this.adOpportunityId,
    this.threadAdSequence,
    this.threadSessionId,
    this.replacedNormalAdInstanceId,
    this.sharedGenerationId,
    this.contributionId,
    this.localGenerationId,
  }) : adInstanceId = adInstanceId ?? newMeasurementId();

  Map<String, Object?> toJson() => {
    'adInstanceId': adInstanceId,
    'adFormat': adFormat,
    'screen': screen,
    'placement': placement,
    'category': category,
    'position': position,
    'adOpportunityId': adOpportunityId,
    'threadAdSequence': threadAdSequence,
    'threadSessionId': threadSessionId,
    'replacedNormalAdInstanceId': replacedNormalAdInstanceId,
    'sharedGenerationId': sharedGenerationId,
    'localGenerationId': localGenerationId,
    'contributionId': contributionId,
  };
}
