cmake_minimum_required(VERSION 3.16)
project(FaultlineEngine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Include directories
include_directories(include)

# Source files
set(SOURCES
    src/main.cpp
)

# Engine Executable
add_executable(faultline_engine ${SOURCES})

# Target include directories
target_include_directories(faultline_engine PRIVATE include)

# Compiler warnings
if (MSVC)
    target_compile_options(faultline_engine PRIVATE /W4)
else()
    target_compile_options(faultline_engine PRIVATE -Wall -Wextra -pedantic)
    target_link_options(faultline_engine PRIVATE -static)
endif()
