# Loaded voltage transfer gain

`spice_tf` accepts an optional `loadResistanceOhm`, a positive finite resistance connected across the voltage output. For `v(a,b)`, the load connects between `a` and `b`; for `v(a)`, it connects between `a` and ground. Current outputs cannot use this option.

The response retains the unloaded `transfer_function`, `input_resistance`, and `output_resistance`. It adds `loaded_transfer_function` and its entry in `units`:

```text
loaded_transfer_function = transfer_function * loadResistanceOhm / (output_resistance + loadResistanceOhm)
```

The loaded gain is V/V for a voltage input and V/A for a current input. With no load option the output is unchanged. A singular denominator or a nonrepresentable result produces a structured error.

This is a Thevenin calculation using one native small-signal transfer-function analysis at the original operating point. It does not add a resistor to the netlist or recompute a nonlinear DC operating point. Use an explicitly loaded circuit when the load changes that operating point.
