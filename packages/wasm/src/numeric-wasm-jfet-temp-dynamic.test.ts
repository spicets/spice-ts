// Bound each coverage fork to one polarity/analysis without dropping cases or assertions.
import { describeJfetTemperatureParity } from './test-support/jfet-temperature-parity.js';

describeJfetTemperatureParity('NJF', 'ac');
