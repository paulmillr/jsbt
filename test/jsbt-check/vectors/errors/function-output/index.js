const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} expected Uint8Array`);
  return value;
};

class BaseState {
  update(message) {
    bytes('message', message);
    return this;
  }
  digestInto(dst) {
    bytes('dst', dst);
  }
  alpha(value) {
    return value;
  }
  beta(value) {
    return value;
  }
  gamma(value) {
    return value;
  }
  delta(value) {
    return value;
  }
  epsilon(value) {
    return value;
  }
  zeta(value) {
    return value;
  }
  eta(value) {
    return value;
  }
  theta(value) {
    return value;
  }
  iota(value) {
    return value;
  }
}

class State extends BaseState {}

export const wrapper = (message) => {
  bytes('message', message);
  return new Uint8Array([1]);
};
wrapper.state = () => new State();
