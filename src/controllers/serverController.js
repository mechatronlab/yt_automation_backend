const VpnServer = require('../models/VpnServer');

// @desc    Add new VPN Server
// @route   POST /api/servers
// @access  Private (Admin in real app, protecting with auth for now)
const addServer = async (req, res, next) => {
  try {
    const { name, ipAddress, publicKey, port, endpoint, isActive } = req.body;

    if (!name || !ipAddress || !publicKey || !endpoint) {
      res.status(400);
      throw new Error('Please provide all required fields');
    }

    const serverExists = await VpnServer.findOne({ ipAddress });
    if (serverExists) {
      res.status(400);
      throw new Error('Server with this IP Address already exists');
    }

    const server = await VpnServer.create({
      name,
      ipAddress,
      publicKey,
      port: port || 51820,
      endpoint,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(server);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all VPN Servers
// @route   GET /api/servers
// @access  Private
const getServers = async (req, res, next) => {
  try {
    const servers = await VpnServer.find({});
    res.status(200).json(servers);
  } catch (error) {
    next(error);
  }
};


const updateServer = async (req, res, next) => {
  try {
    const server = await VpnServer.findById(req.params.id);

    if (!server) {
      res.status(404);
      throw new Error('Server not found');
    }

    const updatedServer = await VpnServer.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    res.status(200).json(updatedServer);
  } catch (error) {
    next(error);
  }
};


const deleteServer = async (req, res, next) => {
  try {
    const server = await VpnServer.findById(req.params.id);

    if (!server) {
      res.status(404);
      throw new Error('Server not found');
    }

    await server.deleteOne();

    res.status(200).json({ id: req.params.id, message: 'Server deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addServer,
  getServers,
  updateServer,
  deleteServer,
};
