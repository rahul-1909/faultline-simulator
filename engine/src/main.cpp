#include "scenario.hpp"
#include <iostream>
#include <string>

using namespace faultline;

int main(int argc, char *argv[])
{
    std::cout << "=========================================================\n";
    std::cout << "  FAULTLINE: Distributed Systems Simulation Engine\n";
    std::cout << "=========================================================\n\n";

    std::string scenario_file = "scenarios/ecommerce_outage.json";
    std::string output_file = "results.json";

    // Parse simple CLI flags
    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];
        if (arg == "--scenario" && i + 1 < argc)
        {
            scenario_file = argv[++i];
        }
        else if (arg == "--output" && i + 1 < argc)
        {
            output_file = argv[++i];
        }
    }

    std::cout << "Loading scenario : " << scenario_file << "\n";
    std::cout << "Output target    : " << output_file << "\n\n";

    SimulationEngine engine;
    if (!engine.load_scenario(scenario_file))
    {
        std::cerr << "Simulation aborted: could not load scenario.\n";
        return 1;
    }

    std::cout << "Running Discrete-Event Simulation...\n";
    engine.run();

    std::cout << "Exporting experiment metrics...\n";
    engine.export_results(output_file);

    return 0;
}