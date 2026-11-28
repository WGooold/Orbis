cmake_minimum_required(VERSION 3.21)
project(OrbisHost VERSION 0.1.27 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Widgets Quick QuickControls2 Network Concurrent)
qt_standard_project_setup(REQUIRES 6.8)
set(ORBIS_DEFAULT_RELAY "wss://orbising.com/relay" CACHE STRING "Default registration and Relay server")
option(ORBIS_QA_BUILD "Build an isolated Host using a packaged QA activation" OFF)
set(ORBIS_QA_ACTIVATION_FILE "" CACHE FILEPATH "Private QA activation JSON to copy into the runtime")
if(ORBIS_QA_ACTIVATION_FILE AND NOT ORBIS_QA_BUILD)
  message(FATAL_ERROR "ORBIS_QA_ACTIVATION_FILE requires ORBIS_QA_BUILD=ON")
endif()
include(CTest)
# CI-PERF-06: compile shared Host support, controller and QML surface sources once
# instead of recompiling them across OrbisHost and 15 test executables.
qt_add_library(orbis-host-support STATIC
  src/StartupSettings.cpp src/StartupSettings.h
  src/DiagnosticLogModel.cpp src/DiagnosticLogModel.h
  src/CredentialStore.cpp src/CredentialStore.h)
target_include_directories(orbis-host-support PUBLIC src)
target_link_libraries(orbis-host-support PUBLIC Qt6::Core PRIVATE $<$<PLATFORM_ID:Windows>:crypt32>)
if(APPLE)
  target_link_libraries(orbis-host-support PUBLIC "-framework Security" "-framework CoreFoundation")
endif()

qt_add_library(orbis-host-controller STATIC src/HostController.cpp src/HostController.h)
target_include_directories(orbis-host-controller PUBLIC src)
target_compile_definitions(orbis-host-controller PUBLIC
  ORBIS_VERSION="${PROJECT_VERSION}"
  ORBIS_DEFAULT_RELAY="${ORBIS_DEFAULT_RELAY}"
  $<$<BOOL:${BUILD_TESTING}>:ORBIS_SMOKE_INTERACTION>
  $<$<BOOL:${ORBIS_QA_BUILD}>:ORBIS_QA_BUILD=1>)
target_link_libraries(orbis-host-controller PUBLIC
  orbis-host-support Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::Concurrent)

qt_add_executable(OrbisHost WIN32 src/main.cpp src/MotionPreferences.cpp src/MotionPreferences.h)
if(WIN32)
  target_sources(OrbisHost PRIVATE src/app.rc)
endif()
if(ORBIS_QA_BUILD)
  target_compile_definitions(OrbisHost PRIVATE ORBIS_QA_BUILD=1)
  set_target_properties(OrbisHost PROPERTIES OUTPUT_NAME "OrbisHost-QA")
  if(APPLE)
    set_target_properties(OrbisHost PROPERTIES OUTPUT_NAME "Orbis Host QA"
      MACOSX_BUNDLE_GUI_IDENTIFIER "com.orbis.host.qa" MACOSX_BUNDLE_BUNDLE_NAME "Orbis Host QA")
    set(_qa_runtime "$<TARGET_BUNDLE_CONTENT_DIR:OrbisHost>/Resources/runtime")
  else()
    set(_qa_runtime "$<TARGET_FILE_DIR:OrbisHost>/runtime")
  endif()
  if(ORBIS_QA_ACTIVATION_FILE)
    if(NOT EXISTS "${ORBIS_QA_ACTIVATION_FILE}")
      message(FATAL_ERROR "The QA activation file does not exist")
    endif()
    set_property(TARGET OrbisHost APPEND PROPERTY LINK_DEPENDS "${ORBIS_QA_ACTIVATION_FILE}")
    add_custom_command(TARGET OrbisHost POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "${_qa_runtime}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${ORBIS_QA_ACTIVATION_FILE}" "${_qa_runtime}/qa-activation.json"
      VERBATIM)
  endif()
endif()
if(APPLE)
  enable_language(OBJCXX)
  target_sources(OrbisHost PRIVATE src/MotionPreferences.mm)
  set_target_properties(OrbisHost PROPERTIES MACOSX_BUNDLE TRUE)
  if(NOT ORBIS_QA_BUILD)
    set_target_properties(OrbisHost PROPERTIES OUTPUT_NAME "Orbis Host"
      MACOSX_BUNDLE_GUI_IDENTIFIER "com.orbis.host" MACOSX_BUNDLE_BUNDLE_NAME "Orbis Host")
  endif()
  set_target_properties(OrbisHost PROPERTIES MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}" MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}")
  set_target_properties(OrbisHost PROPERTIES MACOSX_BUNDLE_ICON_FILE "orbis.icns")
  set_source_files_properties(src/assets/orbis.icns PROPERTIES MACOSX_PACKAGE_LOCATION "Resources")
  target_sources(OrbisHost PRIVATE src/assets/orbis.icns)
  qt_add_resources(OrbisHost macos_branding PREFIX "/" FILES src/assets/orbis-macos.png)
  target_link_libraries(OrbisHost PRIVATE "-framework Security" "-framework CoreFoundation" "-framework AppKit")
endif()
set_source_files_properties(src/qml/Main.qml PROPERTIES QT_RESOURCE_ALIAS Main.qml)
set_source_files_properties(src/qml/Card.qml PROPERTIES QT_RESOURCE_ALIAS Card.qml)
set_source_files_properties(src/qml/ActionButton.qml PROPERTIES QT_RESOURCE_ALIAS ActionButton.qml)
set_source_files_properties(src/qml/DiagnosticLogView.qml PROPERTIES QT_RESOURCE_ALIAS DiagnosticLogView.qml)
set_source_files_properties(src/qml/ProviderFlow.js PROPERTIES QT_RESOURCE_ALIAS ProviderFlow.js QT_QML_SKIP_QMLDIR_ENTRY TRUE)
set_source_files_properties(src/qml/MotionText.qml PROPERTIES QT_RESOURCE_ALIAS MotionText.qml)
set_source_files_properties(src/qml/Motion.js PROPERTIES QT_RESOURCE_ALIAS Motion.js QT_QML_SKIP_QMLDIR_ENTRY TRUE)
set_source_files_properties(src/qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE QT_RESOURCE_ALIAS Theme.qml)
set_source_files_properties(src/qml/Surface.qml PROPERTIES QT_RESOURCE_ALIAS Surface.qml)
set_source_files_properties(src/qml/StatusDot.qml PROPERTIES QT_RESOURCE_ALIAS StatusDot.qml)
set_source_files_properties(src/qml/StatusLabel.qml PROPERTIES QT_RESOURCE_ALIAS StatusLabel.qml)
set_source_files_properties(src/qml/ThemePreview.qml PROPERTIES QT_RESOURCE_ALIAS ThemePreview.qml)
set_source_files_properties(src/qml/SymbolIcon.qml PROPERTIES QT_RESOURCE_ALIAS SymbolIcon.qml)
set_source_files_properties(src/qml/Symbols.js PROPERTIES QT_RESOURCE_ALIAS Symbols.js QT_QML_SKIP_QMLDIR_ENTRY TRUE)
set_source_files_properties(src/qml/AgentLatch.qml PROPERTIES QT_RESOURCE_ALIAS AgentLatch.qml)
set_source_files_properties(src/qml/AgentMark.qml PROPERTIES QT_RESOURCE_ALIAS AgentMark.qml)
set_source_files_properties(src/qml/AgentMarks.js PROPERTIES QT_RESOURCE_ALIAS AgentMarks.js QT_QML_SKIP_QMLDIR_ENTRY TRUE)
set(_orbis_host_qml_files
  src/qml/StatusDot.qml src/qml/StatusLabel.qml src/qml/ThemePreview.qml src/qml/Theme.qml src/qml/Surface.qml
  src/qml/SymbolIcon.qml src/qml/Symbols.js src/qml/AgentMark.qml src/qml/AgentLatch.qml
  src/qml/AgentMarks.js src/qml/MotionText.qml src/qml/Motion.js src/qml/Main.qml
  src/qml/Card.qml src/qml/ActionButton.qml src/qml/DiagnosticLogView.qml src/qml/ProviderFlow.js)
qt_add_qml_module(OrbisHost URI Orbis.Host VERSION 1.0 QML_FILES ${_orbis_host_qml_files} SOURCES src/NeuSurface.cpp src/NeuSurface.h)
qt_add_resources(OrbisHost branding PREFIX "/" FILES src/assets/orbis.png)
set(agent_mark_dir src/assets/agents)
set(agent_mark_files ${agent_mark_dir}/kimi-code.svg ${agent_mark_dir}/opencode-light.svg
                     ${agent_mark_dir}/opencode-dark.svg ${agent_mark_dir}/hermes-light.svg ${agent_mark_dir}/hermes-dark.svg)
qt_add_resources(OrbisHost agent_marks PREFIX "/agent-marks" BASE ${agent_mark_dir} FILES ${agent_mark_files})
target_compile_definitions(OrbisHost PRIVATE ORBIS_VERSION="${PROJECT_VERSION}" ORBIS_DEFAULT_RELAY="${ORBIS_DEFAULT_RELAY}")
target_link_libraries(OrbisHost PRIVATE orbis-host-controller Qt6::Quick Qt6::QuickControls2)
target_include_directories(OrbisHost PRIVATE src)
if(BUILD_TESTING)
  find_package(Qt6 REQUIRED COMPONENTS Test)
  target_link_libraries(OrbisHost PRIVATE Qt6::Test)
  target_compile_definitions(OrbisHost PRIVATE ORBIS_SMOKE_INTERACTION)

  qt_add_library(orbis-neu-surface STATIC src/NeuSurface.cpp src/NeuSurface.h)
  target_include_directories(orbis-neu-surface PUBLIC src)
  target_link_libraries(orbis-neu-surface PUBLIC Qt6::Quick)

  if(ORBIS_QA_BUILD)
    qt_add_library(orbis-host-controller-standard STATIC src/HostController.cpp src/HostController.h)
    target_include_directories(orbis-host-controller-standard PUBLIC src)
    target_compile_definitions(orbis-host-controller-standard PUBLIC
      ORBIS_VERSION="${PROJECT_VERSION}" ORBIS_DEFAULT_RELAY="${ORBIS_DEFAULT_RELAY}" ORBIS_SMOKE_INTERACTION)
    target_link_libraries(orbis-host-controller-standard PUBLIC
      orbis-host-support Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::Concurrent)
    set(_standard_controller orbis-host-controller-standard)
    set(_qa_controller orbis-host-controller)
  else()
    qt_add_library(orbis-host-controller-qa STATIC src/HostController.cpp src/HostController.h)
    target_include_directories(orbis-host-controller-qa PUBLIC src)
    target_compile_definitions(orbis-host-controller-qa PUBLIC
      ORBIS_QA_BUILD=1 ORBIS_VERSION="${PROJECT_VERSION}" ORBIS_DEFAULT_RELAY="${ORBIS_DEFAULT_RELAY}")
    target_link_libraries(orbis-host-controller-qa PUBLIC
      orbis-host-support Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::Concurrent)
    set(_standard_controller orbis-host-controller)
    set(_qa_controller orbis-host-controller-qa)
  endif()

  qt_add_executable(startup-settings-test src/tests/StartupSettingsTest.cpp)
  target_link_libraries(startup-settings-test PRIVATE orbis-host-support Qt6::Test)
  add_test(NAME startup-settings COMMAND startup-settings-test)

  qt_add_executable(credential-store-test src/tests/CredentialStoreTest.cpp)
  target_link_libraries(credential-store-test PRIVATE orbis-host-support Qt6::Test)
  add_test(NAME credential-store COMMAND credential-store-test)

  qt_add_executable(host-activation-test src/tests/HostActivationTest.cpp)
  target_link_libraries(host-activation-test PRIVATE ${_standard_controller} Qt6::Test)
  add_test(NAME host-activation COMMAND host-activation-test -o -,txt)

  qt_add_executable(host-qa-activation-test src/tests/HostQaActivationTest.cpp)
  target_link_libraries(host-qa-activation-test PRIVATE ${_qa_controller} Qt6::Test)
  add_test(NAME host-qa-activation COMMAND host-qa-activation-test -o -,txt)

  qt_add_executable(host-exit-test src/tests/HostExitTest.cpp)
  target_link_libraries(host-exit-test PRIVATE ${_standard_controller} Qt6::Quick Qt6::Test)
  target_compile_definitions(host-exit-test PRIVATE ORBIS_MAIN_QML="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/Main.qml")
  add_test(NAME host-exit COMMAND host-exit-test -o -,txt)

  qt_add_executable(installer-update-test src/tests/InstallerUpdateTest.cpp)
  target_link_libraries(installer-update-test PRIVATE Qt6::Core Qt6::Network Qt6::Test)
  target_compile_definitions(installer-update-test PRIVATE ORBIS_HOST_EXECUTABLE="$<TARGET_FILE:OrbisHost>")
  add_dependencies(installer-update-test OrbisHost)
  add_test(NAME installer-update COMMAND installer-update-test -o -,txt)

  qt_add_executable(host-live-change-test src/tests/HostLiveChangeTest.cpp)
  target_link_libraries(host-live-change-test PRIVATE ${_standard_controller} Qt6::Test)
  add_test(NAME host-live-change COMMAND host-live-change-test -o -,txt)

  qt_add_executable(neu-surface-test src/tests/NeuSurfaceTest.cpp)
  target_link_libraries(neu-surface-test PRIVATE orbis-neu-surface Qt6::Test)
  add_test(NAME neu-surface COMMAND neu-surface-test)

  qt_add_executable(diagnostic-log-test src/tests/DiagnosticLogTest.cpp)
  target_link_libraries(diagnostic-log-test PRIVATE orbis-host-support orbis-neu-surface Qt6::QuickControls2 Qt6::Test)
  # The production module's qmldir resolves its singleton from this resource URL.
  qt_add_resources(diagnostic-log-test diagnostic_log_theme PREFIX "/qt/qml/Orbis/Host" FILES src/qml/Theme.qml)
  target_compile_definitions(diagnostic-log-test PRIVATE ORBIS_LOG_VIEW="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/DiagnosticLogView.qml")
  add_test(NAME diagnostic-log COMMAND diagnostic-log-test -o diagnostic-log.txt,txt)

  qt_add_executable(motion-text-test src/tests/MotionTextTest.cpp)
  target_link_libraries(motion-text-test PRIVATE Qt6::Quick Qt6::Test)
  target_compile_definitions(motion-text-test PRIVATE ORBIS_MOTION_TEXT_QML="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/MotionText.qml")
  add_test(NAME motion-text COMMAND motion-text-test -o -,txt)

  set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/Orbis/Host/qmldir" PROPERTIES QT_RESOURCE_ALIAS qmldir)
  qt_add_executable(action-button-test src/tests/ActionButtonTest.cpp)
  add_dependencies(action-button-test OrbisHost)
  target_link_libraries(action-button-test PRIVATE orbis-neu-surface Qt6::QuickControls2 Qt6::Test)
  qt_add_resources(action-button-test action_button_qml PREFIX "/qt/qml/Orbis/Host" FILES "${CMAKE_CURRENT_BINARY_DIR}/Orbis/Host/qmldir" src/qml/Theme.qml src/qml/Surface.qml src/qml/AgentMark.qml src/qml/AgentMarks.js src/qml/SymbolIcon.qml src/qml/Symbols.js src/qml/MotionText.qml src/qml/Motion.js)
  qt_add_resources(action-button-test test_agent_marks PREFIX "/agent-marks" BASE ${agent_mark_dir} FILES ${agent_mark_files})
  target_compile_definitions(action-button-test PRIVATE ORBIS_ACTION_BUTTON_QML="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/ActionButton.qml")
  add_test(NAME action-button COMMAND action-button-test -o -,txt)

  qt_add_executable(provider-model-test src/tests/ProviderModelTest.cpp)
  target_link_libraries(provider-model-test PRIVATE Qt6::Quick Qt6::Test)
  target_compile_definitions(provider-model-test PRIVATE ORBIS_MAIN_QML="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/Main.qml")
  add_test(NAME provider-model COMMAND provider-model-test -o -,txt)

  qt_add_executable(registration-input-test src/tests/RegistrationInputTest.cpp)
  target_link_libraries(registration-input-test PRIVATE Qt6::QuickControls2 Qt6::Test)
  target_compile_definitions(registration-input-test PRIVATE ORBIS_MAIN_QML="${CMAKE_CURRENT_SOURCE_DIR}/src/qml/Main.qml")
  add_test(NAME registration-input COMMAND registration-input-test -o -,txt)

  # Compile the full QML/branding/mark resource tables once as OBJECT code so static
  # resource initializers are never dead-stripped from either full-UI test binary.
  qt_add_library(orbis-test-host-qml OBJECT)
  add_dependencies(orbis-test-host-qml OrbisHost)
  target_link_libraries(orbis-test-host-qml PRIVATE Qt6::Core)
  qt_add_resources(orbis-test-host-qml shared_test_qml PREFIX "/qt/qml/Orbis/Host" FILES "${CMAKE_CURRENT_BINARY_DIR}/Orbis/Host/qmldir" ${_orbis_host_qml_files})
  qt_add_resources(orbis-test-host-qml shared_test_branding PREFIX "/" FILES src/assets/orbis.png)
  qt_add_resources(orbis-test-host-qml shared_test_marks PREFIX "/agent-marks" BASE ${agent_mark_dir} FILES ${agent_mark_files})

  qt_add_executable(overview-row-hover-test src/tests/OverviewRowHoverTest.cpp)
  target_link_libraries(overview-row-hover-test PRIVATE orbis-test-host-qml ${_standard_controller} orbis-neu-surface Qt6::QuickControls2 Qt6::Test)
  if(WIN32)
    # The GUI subsystem can leave stdout empty under CTest on Windows.
    add_test(NAME overview-row-hover COMMAND overview-row-hover-test -o overview-row-hover.txt,txt)
  else()
    add_test(NAME overview-row-hover COMMAND overview-row-hover-test -o -,txt)
  endif()

  qt_add_executable(mobile-download-layout-test src/tests/MobileDownloadLayoutTest.cpp)
  target_link_libraries(mobile-download-layout-test PRIVATE orbis-test-host-qml ${_standard_controller} orbis-neu-surface Qt6::QuickControls2 Qt6::Test)
  add_test(NAME mobile-download-layout COMMAND mobile-download-layout-test -o -,txt)

  # Serialize windowed Quick tests so parallel CTest workers never contend for hover/focus.
  set_tests_properties(
    host-exit installer-update diagnostic-log motion-text action-button
    provider-model registration-input overview-row-hover mobile-download-layout
    PROPERTIES RESOURCE_LOCK gui_window)
endif()
