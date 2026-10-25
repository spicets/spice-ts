/*
 * Deterministic bounded dense f64 Gaussian elimination kernel.
 * No imports, WASI, allocation, threads, SIMD, clock, or randomness.
 */

#define MAX_ORDER 64
#define FINITE_MAX 1.7976931348623157e308

static double magnitude(double value) {
  return value < 0 ? -value : value;
}

static int finite(double value) {
  return value == value && magnitude(value) <= FINITE_MAX;
}

__attribute__((export_name("abi_version")))
int abi_version(void) {
  return 2;
}

__attribute__((export_name("max_order")))
int max_order(void) {
  return MAX_ORDER;
}

static int valid_node(int node, int order) {
  return node >= -1 && node < order;
}

__attribute__((export_name("stamp_vccs_f64")))
int stamp_vccs_f64(
  int order,
  double *matrix,
  int output_positive,
  int output_negative,
  int control_positive,
  int control_negative,
  double transconductance
) {
  if (order < 1 || order > MAX_ORDER || matrix == 0 || ((unsigned long)matrix & 7)
      || !valid_node(output_positive, order) || !valid_node(output_negative, order)
      || !valid_node(control_positive, order) || !valid_node(control_negative, order)) return 3;
  if (!finite(transconductance)) return 2;

  if (output_positive >= 0 && control_positive >= 0) {
    int index = output_positive * order + control_positive;
    matrix[index] += transconductance;
    if (!finite(matrix[index])) return 2;
  }
  if (output_positive >= 0 && control_negative >= 0) {
    int index = output_positive * order + control_negative;
    matrix[index] -= transconductance;
    if (!finite(matrix[index])) return 2;
  }
  if (output_negative >= 0 && control_positive >= 0) {
    int index = output_negative * order + control_positive;
    matrix[index] -= transconductance;
    if (!finite(matrix[index])) return 2;
  }
  if (output_negative >= 0 && control_negative >= 0) {
    int index = output_negative * order + control_negative;
    matrix[index] += transconductance;
    if (!finite(matrix[index])) return 2;
  }
  return 0;
}

__attribute__((export_name("stamp_cccs_f64")))
int stamp_cccs_f64(
  int order,
  double *matrix,
  int output_positive,
  int output_negative,
  int control_branch_column,
  double current_gain
) {
  if (order < 1 || order > MAX_ORDER || matrix == 0 || ((unsigned long)matrix & 7)
      || !valid_node(output_positive, order) || !valid_node(output_negative, order)
      || control_branch_column < 0 || control_branch_column >= order) return 3;
  if (!finite(current_gain)) return 2;

  if (output_positive >= 0) {
    int index = output_positive * order + control_branch_column;
    matrix[index] += current_gain;
    if (!finite(matrix[index])) return 2;
  }
  if (output_negative >= 0) {
    int index = output_negative * order + control_branch_column;
    matrix[index] -= current_gain;
    if (!finite(matrix[index])) return 2;
  }
  return 0;
}

__attribute__((export_name("stamp_vcvs_f64")))
int stamp_vcvs_f64(
  int order,
  double *matrix,
  int output_positive,
  int output_negative,
  int control_positive,
  int control_negative,
  int branch_column,
  double voltage_gain
) {
  if (order < 1 || order > MAX_ORDER || matrix == 0 || ((unsigned long)matrix & 7)
      || !valid_node(output_positive, order) || !valid_node(output_negative, order)
      || !valid_node(control_positive, order) || !valid_node(control_negative, order)
      || branch_column < 0 || branch_column >= order) return 3;
  if (!finite(voltage_gain)) return 2;

  if (output_positive >= 0) {
    int index = output_positive * order + branch_column;
    matrix[index] += 1;
    if (!finite(matrix[index])) return 2;
    index = branch_column * order + output_positive;
    matrix[index] += 1;
    if (!finite(matrix[index])) return 2;
  }
  if (output_negative >= 0) {
    int index = output_negative * order + branch_column;
    matrix[index] -= 1;
    if (!finite(matrix[index])) return 2;
    index = branch_column * order + output_negative;
    matrix[index] -= 1;
    if (!finite(matrix[index])) return 2;
  }
  if (control_positive >= 0) {
    int index = branch_column * order + control_positive;
    matrix[index] -= voltage_gain;
    if (!finite(matrix[index])) return 2;
  }
  if (control_negative >= 0) {
    int index = branch_column * order + control_negative;
    matrix[index] += voltage_gain;
    if (!finite(matrix[index])) return 2;
  }
  return 0;
}

__attribute__((export_name("stamp_ccvs_f64")))
int stamp_ccvs_f64(
  int order,
  double *matrix,
  int output_positive,
  int output_negative,
  int control_branch_column,
  int branch_column,
  double transresistance
) {
  if (order < 1 || order > MAX_ORDER || matrix == 0 || ((unsigned long)matrix & 7)
      || !valid_node(output_positive, order) || !valid_node(output_negative, order)
      || control_branch_column < 0 || control_branch_column >= order
      || branch_column < 0 || branch_column >= order) return 3;
  if (!finite(transresistance)) return 2;

  if (output_positive >= 0) {
    int index = output_positive * order + branch_column;
    matrix[index] += 1;
    if (!finite(matrix[index])) return 2;
    index = branch_column * order + output_positive;
    matrix[index] += 1;
    if (!finite(matrix[index])) return 2;
  }
  if (output_negative >= 0) {
    int index = output_negative * order + branch_column;
    matrix[index] -= 1;
    if (!finite(matrix[index])) return 2;
    index = branch_column * order + output_negative;
    matrix[index] -= 1;
    if (!finite(matrix[index])) return 2;
  }
  {
    int index = branch_column * order + control_branch_column;
    matrix[index] -= transresistance;
    if (!finite(matrix[index])) return 2;
  }
  return 0;
}

static int solve_real(int order, double *matrix, double *rhs, int singleton_first) {
  if (order < 1 || order > MAX_ORDER || matrix == 0 || rhs == 0) return 3;

  for (int index = 0; index < order * order; index++) {
    if (!finite(matrix[index])) return 2;
  }
  for (int index = 0; index < order; index++) {
    if (!finite(rhs[index])) return 2;
  }

  int columns[MAX_ORDER];
  for (int column = 0; column < order; column++) columns[column] = column;

  for (int column = 0; column < order; column++) {
    /* Structural column singletons first, like core's sparse LU. Voltage
     * source branches are singletons in MNA. Eliminating nodes first can
     * lose leakage currents to cancellation between large RHS terms.
     * This rule does not depend on device type, temperature or magnitudes. */
    int selected = column;
    for (int candidate = column; singleton_first && candidate < order; candidate++) {
      int nonzero = 0;
      for (int row = column; row < order; row++) {
        if (matrix[row * order + candidate] != 0) nonzero++;
      }
      if (nonzero == 1) { selected = candidate; break; }
    }
    if (selected != column) {
      for (int row = 0; row < order; row++) {
        double temporary = matrix[row * order + column];
        matrix[row * order + column] = matrix[row * order + selected];
        matrix[row * order + selected] = temporary;
      }
      int temporary = columns[column];
      columns[column] = columns[selected];
      columns[selected] = temporary;
    }
    int pivot = column;
    double largest = magnitude(matrix[column * order + column]);
    for (int row = column + 1; row < order; row++) {
      double candidate = magnitude(matrix[row * order + column]);
      if (candidate > largest) {
        largest = candidate;
        pivot = row;
      }
    }
    if (!(largest > 0)) return 1;

    if (pivot != column) {
      for (int entry = column; entry < order; entry++) {
        double temporary = matrix[column * order + entry];
        matrix[column * order + entry] = matrix[pivot * order + entry];
        matrix[pivot * order + entry] = temporary;
      }
      double temporary = rhs[column];
      rhs[column] = rhs[pivot];
      rhs[pivot] = temporary;
    }

    for (int row = column + 1; row < order; row++) {
      double factor = matrix[row * order + column] / matrix[column * order + column];
      if (!finite(factor)) return 2;
      matrix[row * order + column] = 0;
      for (int entry = column + 1; entry < order; entry++) {
        matrix[row * order + entry] -= factor * matrix[column * order + entry];
        if (!finite(matrix[row * order + entry])) return 2;
      }
      rhs[row] -= factor * rhs[column];
      if (!finite(rhs[row])) return 2;
    }
  }

  if (!singleton_first) {
    /* Preserve the established transient/AC-bias accumulation order: rounding
     * changes here feed back into adaptive transient step selection. */
    for (int row = order - 1; row >= 0; row--) {
      double value = rhs[row];
      for (int column = row + 1; column < order; column++) {
        value -= matrix[row * order + column] * rhs[column];
      }
      rhs[row] = value / matrix[row * order + row];
      if (!finite(rhs[row])) return 2;
    }
    return 0;
  }

  double solution[MAX_ORDER];
  /* Column-oriented substitution preserves the sparse solver's accumulation
   * order when a source current is the difference of large node terms. */
  for (int column = order - 1; column >= 0; column--) {
    double value = rhs[column] / matrix[column * order + column];
    if (!finite(value)) return 2;
    solution[columns[column]] = value;
    for (int row = 0; row < column; row++) {
      rhs[row] -= matrix[row * order + column] * value;
    }
  }
  for (int row = 0; row < order; row++) rhs[row] = solution[row];
  return 0;
}

__attribute__((export_name("solve_f64")))
int solve_f64(int order, double *matrix, double *rhs) {
  return solve_real(order, matrix, rhs, 0);
}

__attribute__((export_name("solve_dc_f64")))
int solve_dc_f64(int order, double *matrix, double *rhs) {
  return solve_real(order, matrix, rhs, 1);
}

static int complex_divide(
  double numerator_real,
  double numerator_imaginary,
  double denominator_real,
  double denominator_imaginary,
  double *result_real,
  double *result_imaginary
) {
  double ratio;
  double denominator;
  if (magnitude(denominator_real) >= magnitude(denominator_imaginary)) {
    if (denominator_real == 0) return 1;
    ratio = denominator_imaginary / denominator_real;
    denominator = denominator_real + denominator_imaginary * ratio;
    *result_real = (numerator_real + numerator_imaginary * ratio) / denominator;
    *result_imaginary = (numerator_imaginary - numerator_real * ratio) / denominator;
  } else {
    ratio = denominator_real / denominator_imaginary;
    denominator = denominator_imaginary + denominator_real * ratio;
    *result_real = (numerator_real * ratio + numerator_imaginary) / denominator;
    *result_imaginary = (numerator_imaginary * ratio - numerator_real) / denominator;
  }
  return finite(*result_real) && finite(*result_imaginary) ? 0 : 2;
}

__attribute__((export_name("solve_complex_f64")))
int solve_complex_f64(
  int order,
  double *matrix_real,
  double *matrix_imaginary,
  double *rhs_real,
  double *rhs_imaginary
) {
  if (order < 1 || order > MAX_ORDER || matrix_real == 0 || matrix_imaginary == 0
      || rhs_real == 0 || rhs_imaginary == 0) return 3;
  if (((unsigned long)matrix_real | (unsigned long)matrix_imaginary
      | (unsigned long)rhs_real | (unsigned long)rhs_imaginary) & 7) return 3;

  for (int index = 0; index < order * order; index++) {
    if (!finite(matrix_real[index]) || !finite(matrix_imaginary[index])) return 2;
  }
  for (int index = 0; index < order; index++) {
    if (!finite(rhs_real[index]) || !finite(rhs_imaginary[index])) return 2;
  }

  for (int column = 0; column < order; column++) {
    int pivot = column;
    int pivot_index = column * order + column;
    double largest = magnitude(matrix_real[pivot_index]);
    double imaginary_magnitude = magnitude(matrix_imaginary[pivot_index]);
    if (imaginary_magnitude > largest) largest = imaginary_magnitude;
    for (int row = column + 1; row < order; row++) {
      int index = row * order + column;
      double candidate = magnitude(matrix_real[index]);
      imaginary_magnitude = magnitude(matrix_imaginary[index]);
      if (imaginary_magnitude > candidate) candidate = imaginary_magnitude;
      if (candidate > largest) {
        largest = candidate;
        pivot = row;
      }
    }
    if (!(largest > 0)) return 1;

    if (pivot != column) {
      for (int entry = column; entry < order; entry++) {
        int upper = column * order + entry;
        int lower = pivot * order + entry;
        double temporary = matrix_real[upper];
        matrix_real[upper] = matrix_real[lower];
        matrix_real[lower] = temporary;
        temporary = matrix_imaginary[upper];
        matrix_imaginary[upper] = matrix_imaginary[lower];
        matrix_imaginary[lower] = temporary;
      }
      double temporary = rhs_real[column];
      rhs_real[column] = rhs_real[pivot];
      rhs_real[pivot] = temporary;
      temporary = rhs_imaginary[column];
      rhs_imaginary[column] = rhs_imaginary[pivot];
      rhs_imaginary[pivot] = temporary;
    }

    pivot_index = column * order + column;
    for (int row = column + 1; row < order; row++) {
      int row_index = row * order + column;
      double factor_real;
      double factor_imaginary;
      int division = complex_divide(
        matrix_real[row_index], matrix_imaginary[row_index],
        matrix_real[pivot_index], matrix_imaginary[pivot_index],
        &factor_real, &factor_imaginary
      );
      if (division != 0) return division;
      matrix_real[row_index] = 0;
      matrix_imaginary[row_index] = 0;
      for (int entry = column + 1; entry < order; entry++) {
        int target = row * order + entry;
        int source = column * order + entry;
        double product_real = factor_real * matrix_real[source]
          - factor_imaginary * matrix_imaginary[source];
        double product_imaginary = factor_real * matrix_imaginary[source]
          + factor_imaginary * matrix_real[source];
        matrix_real[target] -= product_real;
        matrix_imaginary[target] -= product_imaginary;
        if (!finite(matrix_real[target]) || !finite(matrix_imaginary[target])) return 2;
      }
      double rhs_product_real = factor_real * rhs_real[column]
        - factor_imaginary * rhs_imaginary[column];
      double rhs_product_imaginary = factor_real * rhs_imaginary[column]
        + factor_imaginary * rhs_real[column];
      rhs_real[row] -= rhs_product_real;
      rhs_imaginary[row] -= rhs_product_imaginary;
      if (!finite(rhs_real[row]) || !finite(rhs_imaginary[row])) return 2;
    }
  }

  for (int row = order - 1; row >= 0; row--) {
    double value_real = rhs_real[row];
    double value_imaginary = rhs_imaginary[row];
    for (int column = row + 1; column < order; column++) {
      int index = row * order + column;
      value_real -= matrix_real[index] * rhs_real[column]
        - matrix_imaginary[index] * rhs_imaginary[column];
      value_imaginary -= matrix_real[index] * rhs_imaginary[column]
        + matrix_imaginary[index] * rhs_real[column];
    }
    int diagonal = row * order + row;
    int division = complex_divide(
      value_real, value_imaginary,
      matrix_real[diagonal], matrix_imaginary[diagonal],
      &rhs_real[row], &rhs_imaginary[row]
    );
    if (division != 0) return division;
  }
  return 0;
}
