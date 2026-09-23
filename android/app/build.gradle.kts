plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.pi.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.pi.remote"
        minSdk = 26
        targetSdk = 35
        versionCode = 45
        versionName = "0.1.44"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }

    // 单测跑在桌面上，`android.util.Log` 这类平台静态方法默认会抛“not mocked”。APP 里
    // 有些排障日志就写在会被单测直接驱动的纯函数里（例如 session.list 的落地诊断），
    // 那是刻意的——手机出问题时 logcat 抓不到，只能靠这些日志定位。允许平台方法返回默认值，
    // 这些日志在单测里变成 no-op，不会把一条诊断变成测试失败。
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("org.commonmark:commonmark:0.24.0")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.24.0")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.24.0")
    implementation("org.commonmark:commonmark-ext-task-list-items:0.24.0")
    implementation("org.commonmark:commonmark-ext-autolink:0.24.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // P2P 打洞（M5）：WebRTC DataChannel。NAT 穿透由 ICE/STUN 内置，
    // DataChannel 一条消息=一个 v2.frame，加密仍由我们的 Envelope E2E 负责。
    // WebRTC：官方 org.webrtc:google-webrtc 只在已死的 JCenter 上，改用 getstream 维护的
    // Maven Central fork（API 兼容，包名仍是 org.webrtc）。
    implementation("io.getstream:stream-webrtc-android:1.3.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // E2E 加密的 X25519：直接用 BC 的 RFC 7748 底层 API（不走 JCE provider，
    // 避免与 Android 系统自带的古董版 BC 冲突）。HKDF/HMAC/AES-GCM 用平台自带的 javax.crypto。
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")

    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
