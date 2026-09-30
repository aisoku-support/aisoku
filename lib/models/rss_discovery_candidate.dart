class RssDiscoveryCandidate {
  const RssDiscoveryCandidate({
    required this.url,
    required this.title,
    required this.isRegistered,
  });

  final String url;
  final String title;
  final bool isRegistered;

  RssDiscoveryCandidate copyWith({bool? isRegistered}) {
    return RssDiscoveryCandidate(
      url: url,
      title: title,
      isRegistered: isRegistered ?? this.isRegistered,
    );
  }
}
