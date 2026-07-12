cmake_minimum_required(VERSION 3.15)

project(BatterySimEngine LANGUAGES CXX)


set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(BATTERYSIM
    src/main.cpp
    src/BatteryCell.cpp
    src/BatteryPack.cpp
)

target_include_directories(battery_sim PUBLIC include)