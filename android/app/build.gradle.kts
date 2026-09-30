import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

if (gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }) {
    for (key in listOf("storeFile", "storePassword", "keyAlias", "keyPassword")) {
        require(!keystoreProperties.getProperty(key).isNullOrBlank()) {
            "Release signing requires $key in android/key.properties."
        }
    }
    require(file(keystoreProperties.getProperty("storeFile")).isFile) {
        "Release signing keystore file does not exist. Check android/key.properties."
    }
}

// Flutter build-time configuration; never substitute a fabricated release ID.
val adMobDefines = (project.findProperty("dart-defines") as String?)
    ?.split(",")?.mapNotNull {
        val decoded = String(Base64.getDecoder().decode(it))
        val parts = decoded.split("=", limit = 2)
        if (parts.size == 2) parts[0] to parts[1] else null
    }?.toMap() ?: emptyMap()
val productionAdMobAppId = adMobDefines["ADMOB_APP_ID"] ?: ""
if (gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }) {
    require(productionAdMobAppId.matches(Regex("ca-app-pub-[0-9]{16}~[0-9]{10}")) &&
        !productionAdMobAppId.startsWith("ca-app-pub-3940256099942544")) {
        "Release requires a production ADMOB_APP_ID via --dart-define."
    }
    for (key in listOf("ADMOB_NEWS_BANNER_ID", "ADMOB_NEWS_NATIVE_ID", "ADMOB_THREAD_NATIVE_ID")) {
        val value = adMobDefines[key] ?: ""
        require(value.matches(Regex("ca-app-pub-[0-9]{16}/[0-9]{10}")) &&
            !value.startsWith("ca-app-pub-3940256099942544")) { "Release requires $key via --dart-define." }
    }
}

android {
    namespace = "com.aisoku.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.aisoku.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = maxOf(flutter.minSdkVersion, 24)
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["adMobAppId"] = "ca-app-pub-3940256099942544~3347511713"
    }

    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties.getProperty("keyAlias")
            keyPassword = keystoreProperties.getProperty("keyPassword")
            storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }
            storePassword = keystoreProperties.getProperty("storePassword")
        }
    }

    buildTypes {
        release {
            manifestPlaceholders["adMobAppId"] = productionAdMobAppId
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("androidx.browser:browser:1.8.0")
}
